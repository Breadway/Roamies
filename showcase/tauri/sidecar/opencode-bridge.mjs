// Drop-in replacement for the native background agents, backed by real opencode sessions on Hermes and Hestia.
// The native agents.mjs stays in place; this module takes over its call paths (send_agent, tell_agent, stop_agent,
// agent_report, scheduled jobs, the live state and the agents' corner). It uses the same opencode HTTP API as the
// opencode-agents MCP server, with the host config from ~/.config/opencode-agents-mcp/config.json.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = os.homedir();
const CONFIG_PATH = path.join(HOME, '.config', 'opencode-agents-mcp', 'config.json');
const STATE_PATH = path.join(HOME, '.config', 'opencode-agents-mcp', 'bridge-state.json');
const service = () => { try { return JSON.parse(fs.readFileSync(path.join(HOME, '.config', 'opencode', 'service.json'), 'utf8')); } catch { return {}; } };
const readJson = (p, fallback) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; } };

function hostConfig(name) {
  const cfg = readJson(CONFIG_PATH, {});
  const hosts = cfg.hosts ?? {};
  if (!hosts.hermes) hosts.hermes = { url: 'http://127.0.0.1:7402' };
  const key = String(name || cfg.defaultHost || 'hermes').toLowerCase();
  const h = hosts[key];
  if (!h) throw new Error(`Unknown opencode host "${key}". Known: ${Object.keys(hosts).join(', ')}.`);
  const password = process.env[`OPENCODE_${key.toUpperCase()}_PASSWORD`] || h.password || (key === 'hermes' ? service().password : '');
  if (!password) throw new Error(`No opencode password for ${key}.`);
  return { name: key, url: String(h.url || '').replace(/\/+$/, ''), password };
}

async function api(name, method, route, body, timeout = 30_000) {
  const h = hostConfig(name);
  const res = await fetch(h.url + route, {
    method,
    headers: { authorization: 'Basic ' + Buffer.from(`opencode:${h.password}`).toString('base64'), 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  });
  const text = await res.text();
  let data = text;
  try { data = text ? JSON.parse(text) : null; } catch {}
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status}${data?.message ? ` ${data.message}` : ''}`);
  return data && typeof data === 'object' && 'data' in data ? data.data : data;
}

const abs = (folder) => {
  let f = String(folder ?? '').trim() || '~';
  if (f === '~' || f.startsWith('~/')) f = path.join(HOME, f.slice(1));
  return path.resolve(f);
};
const summary = (text, n = 500) => {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > n ? `${flat.slice(0, n)}…` : flat;
};
function lastResult(msgs) {
  const ordered = [...msgs].sort((a, b) => (a.time?.created ?? 0) - (b.time?.created ?? 0));
  const lastUser = ordered.map((m) => m.type).lastIndexOf('user');
  const idle = ordered.slice(lastUser + 1).filter((m) => m.type === 'idle').pop();
  const assistant = ordered.slice(lastUser + 1).filter((m) => m.type === 'assistant').pop();
  const text = assistant ? (assistant.content ?? []).filter((p) => p.type === 'text').map((p) => p.text).join('\n').trim() : '';
  return { status: idle ? 'idle' : 'working', outcome: idle?.outcome ?? null, text };
}

export function createOpencodeBridge({ ui, enqueue, say, userName = 'breadway', log = () => {} }) {
  const sessions = new Map(); // id -> {id, host, title, folder, started, state, done, reported, summary, reason, ended}
  let cache = []; // every session seen by the last poll, for the live state and list
  const now = () => Date.now();

  function loadState() {
    const s = readJson(STATE_PATH, { sessions: {} });
    for (const [id, v] of Object.entries(s.sessions ?? {})) sessions.set(id, v);
  }
  function saveState() {
    try {
      fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
      fs.writeFileSync(STATE_PATH, JSON.stringify({ sessions: Object.fromEntries(sessions) }, null, 2), { mode: 0o600 });
    } catch (e) { log('opencode_state', { error: String(e.message) }); }
  }
  loadState();

  const pub = (s) => ({
    id: s.id, title: s.title || s.id, type: 'opencode', sub: null, state: s.state === 'stopped' ? 'gone' : s.state,
    step: '', tool: null, started: s.started, ended: s.ended ?? null, workMs: Math.max(0, (s.ended ?? now()) - (s.started ?? now())),
    live: s.state === 'working', ask: null, reason: s.reason ?? null,
    result: s.state === 'done' ? { outcome: s.summary || 'finished', needs_you: null, files: [], place: null } : null,
  });
  const tell = (type, s) => { try { ui({ kind: 'agents', e: { type, agent: pub(s) } }); } catch {} };

  async function create({ title, brief, folder, host = 'hermes', agent, model }) {
    if (!String(brief ?? '').trim()) throw new Error('The brief is empty.');
    const directory = abs(folder);
    if (host === 'hermes') {
      const st = fs.statSync(directory, { throwIfNoEntry: false });
      if (!st?.isDirectory()) throw new Error(`There is no folder at ${directory}.`);
    }
    const body = {
      title: title || `opencode in ${path.basename(directory) || directory}`,
      location: { directory },
      permissions: [{ action: '*', resource: '*', effect: 'allow' }],
    };
    if (agent) body.agent = agent;
    if (model) body.model = model;
    const info = await api(host, 'POST', '/api/session', body);
    const s = { id: info.id, host, title: info.title || title || info.id, folder: info.location?.directory || directory, started: now(), state: 'working', done: false, reported: false, summary: '', reason: null, ended: null };
    sessions.set(s.id, s);
    saveState();
    await api(host, 'POST', `/api/session/${encodeURIComponent(s.id)}/prompt`, { text: String(brief), delivery: 'steer' });
    tell('launch', s);
    log('opencode_start', { id: s.id, host, folder: directory });
    return s;
  }

  async function listHost(name) {
    const [active, all] = await Promise.all([
      api(name, 'GET', '/api/session/active', undefined, 8000).catch(() => ({})),
      api(name, 'GET', '/api/session', undefined, 15_000).catch(() => []),
    ]);
    return (Array.isArray(all) ? all : []).map((x) => ({
      host: name, id: x.id, title: x.title || '', folder: x.location?.directory || '',
      agent: x.agent ?? null, model: x.model ?? null, updated: x.time?.updated ?? 0, status: active?.[x.id] ? 'running' : 'idle',
    }));
  }

  async function list(host) {
    const names = host ? [String(host).toLowerCase()] : Object.keys(readJson(CONFIG_PATH, {}).hosts ?? { hermes: {} });
    const out = [];
    for (const name of names) out.push(...await listHost(name).catch(() => []));
    return out.sort((a, b) => b.updated - a.updated);
  }

  // Synchronous on purpose: the news desk calls this every second and filters the array in place.
  // Shape matches the native agentNews items so newsText/newsBlock can print it unchanged.
  function news() {
    return [...sessions.values()]
      .filter((s) => s.state === 'done' && !s.reported)
      .map((s) => ({
        id: s.id, title: s.title || s.id, type: 'opencode', kind: s.reason ? 'failed' : 'done',
        old: s.delivered === true, outcome: s.summary || 'finished', report: s.summary || null,
        needs_you: null, files: [], place: s.folder || null, question: null,
        reason: s.reason ?? null, asked: null,
      }));
  }
  function markTold(ids) {
    for (const id of ids ?? []) {
      const s = sessions.get(String(id));
      if (s) { s.reported = true; s.delivered = true; }
    }
    saveState();
  }

  async function tick() {
    try {
      const all = await list();
      cache = all;
      for (const s of sessions.values()) {
        if (s.state !== 'working') continue;
        const row = all.find((x) => x.host === s.host && x.id === s.id);
        if (row?.status === 'running') { tell('update', s); continue; }
        let msgs;
        try { msgs = await api(s.host, 'GET', `/api/session/${encodeURIComponent(s.id)}/message`, undefined, 15_000); } catch { continue; }
        const r = lastResult(Array.isArray(msgs) ? msgs : []);
        if (r.status !== 'idle') { tell('update', s); continue; }
        Object.assign(s, { state: 'done', done: true, ended: now(), summary: summary(r.text), reason: r.outcome === 'failed' ? 'opencode reported a failure' : null });
        tell('done', s);
        saveState();
        log('opencode_done', { id: s.id, host: s.host, folder: s.folder });
      }
    } catch (e) { log('opencode_poll', { error: String(e.message).slice(0, 160) }); }
  }
  const timer = setInterval(tick, 5000);
  timer.unref?.();

  async function send(id, text, host) {
    const s = sessions.get(String(id));
    const name = host || s?.host || 'hermes';
    await api(name, 'POST', `/api/session/${encodeURIComponent(id)}/prompt`, { text: String(text), delivery: 'steer' });
    if (s) { s.state = 'working'; s.done = false; s.reported = false; tell('update', s); saveState(); }
    return { host: name, id };
  }

  async function stop(id, hostArg) {
    const s = sessions.get(String(id));
    const host = hostArg || s?.host || 'hermes';
    await api(host, 'POST', `/api/session/${encodeURIComponent(id)}/interrupt`).catch(() => {});
    if (s) {
      Object.assign(s, { state: 'stopped', reason: 'stopped', ended: now(), done: true, reported: true });
      tell('gone', s);
      saveState();
    }
  }

  async function result(id, { full = false, host: hostArg } = {}) {
    const s = sessions.get(String(id));
    const host = hostArg || s?.host || 'hermes';
    const info = await api(host, 'GET', `/api/session/${encodeURIComponent(id)}`).catch(() => null);
    let msgs = [];
    try { msgs = await api(host, 'GET', `/api/session/${encodeURIComponent(id)}/message`, undefined, 15_000); } catch {}
    const r = lastResult(Array.isArray(msgs) ? msgs : []);
    const text = full ? (r.text || '(no text yet)') : (summary(r.text) || '(no text yet)');
    return `Session ${id} on ${host} is ${r.status}${r.outcome ? ` (${r.outcome})` : ''}.\n${info?.title || s?.title || ''}\n${info?.location?.directory || s?.folder || ''}\n${text}\nWatch: opencode -s ${id}`;
  }

  function liveText() {
    const rows = (cache.length ? cache : [...sessions.values()].map((s) => ({ host: s.host, id: s.id, title: s.title, folder: s.folder, status: s.state === 'working' ? 'running' : 'idle', updated: s.started })))
      .filter((x) => x.status === 'running' || sessions.has(x.id))
      .slice(0, 20);
    if (!rows.length) return '';
    return `OpenCode sessions (ids for tell_agent, stop_agent and agent_report):\n${rows.map((x) => `- ${x.id} [${x.status}] ${x.folder || ''}${x.title ? ` - ${x.title}` : ''} on ${x.host}`).join('\n')}`;
  }

  function get(id) {
    return sessions.get(String(id)) ?? null;
  }
  function sync() {
    for (const s of sessions.values()) if (s.state === 'working') tell('update', s);
  }
  function dismiss(id) {
    const s = sessions.get(String(id));
    if (!s) return false;
    s.state = 'gone'; saveState();
    return true;
  }

  return { create, send, stop, result, list, news, markTold, liveText, get, sync, dismiss, refresh: tick, pub };
}
