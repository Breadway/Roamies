// Breadboard chat for JARVIS: watch DMs and @pings, answer them through the normal Roamies turn,
// then post the answer back to the room. No MCP round trip, so it works without an approval bubble.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = os.homedir();
const CONFIG_PATH = path.join(HOME, '.config', 'breadboard', 'cli.toml');
const STATE_PATH = path.join(HOME, 'Roamies', 'Data', 'breadboard-chat.json');
const POLL_MS = 8000;
const CAPTURE_MS = 240_000;
const REGISTER_MS = 10 * 60_000;
const REGISTER_RETRY_MS = 60_000;

/** cli.toml is flat enough for this: server and token are plain top-level strings. */
function readConfig() {
  const text = fs.readFileSync(CONFIG_PATH, 'utf8');
  const pick = (key) => text.match(new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"`, 'm'))?.[1] ?? '';
  const server = pick('server').replace(/\/+$/, '');
  const token = pick('token');
  if (!server || !token) throw new Error('breadboard cli.toml has no server or token');
  return { server, token };
}

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')); } catch { return {}; }
}

function writeState(state) {
  try {
    fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
    fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), { mode: 0o600 });
  } catch {}
}

const clip = (text, n = 1200) => {
  const flat = String(text ?? '').replace(/[ \t]+/g, ' ').trim();
  return flat.length > n ? `${flat.slice(0, n)}...` : flat;
};

export function createBreadboardChat({ enqueue, ui, log = () => {}, agent = 'jarvis', host = os.hostname() } = {}) {
  const { server, token } = readConfig();
  const state = readState();
  let lastPushId = Number(state.lastPushId) || 0;
  let seeded = state.seeded === true;
  let armed = null;      // push being answered: { id, roomId, roomName, author }
  let capture = null;    // text collected from the turn: { roomId, body }
  let captureTimer = null;
  let polling = false;
  let stopped = false;
  let pollTimer = null;
  let registerTimer = null;
  let lastRegister = 0;
  let registering = false;
  let lastPollError = '';

  async function api(method, route, body, timeout = 20_000) {
    const res = await fetch(server + route, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeout),
    });
    const text = await res.text();
    let data = text;
    try { data = text ? JSON.parse(text) : null; } catch {}
    if (!res.ok) throw new Error(`HTTP ${res.status}${data?.error ? ` ${data.error}` : data?.message ? ` ${data.message}` : ''}`);
    return data;
  }

  async function register(force = false) {
    if (registering) return;
    if (!force && lastRegister && Date.now() - lastRegister < REGISTER_MS) return;
    registering = true;
    let r;
    try {
      r = await api('POST', '/api/agents/register', {
        agent_name: agent, session_id: `roamies-${String(host).replace(/[^a-z0-9.-]/gi, '-').toLowerCase()}`, host, pid: process.pid,
        note: 'Roamies desktop, breadboard chat',
      }, 30_000);
    } finally {
      registering = false;
    }
    const name = String(r?.agent_name ?? '').trim().toLowerCase();
    if (name && name !== agent) {
      // The name belongs to another live session. Do not post under a name this bridge cannot own.
      throw new Error(`breadboard gave ${name} instead of ${agent}`);
    }
    lastRegister = Date.now();
    log('breadboard_chat_register', { agent, live: r?.live ?? null });
  }

  /** On the very first run, start from now rather than answering every ping from the past. */
  async function seed() {
    let after = 0, max = 0;
    for (let i = 0; i < 20; i++) {
      const pushes = await api('GET', `/api/chat/pushes?agent=${encodeURIComponent(agent)}&after=${after}&limit=100`);
      if (!Array.isArray(pushes) || !pushes.length) break;
      for (const p of pushes) max = Math.max(max, p.id);
      after = max;
      if (pushes.length < 100) break;
    }
    lastPushId = max;
    seeded = true;
    writeState({ lastPushId, seeded });
    log('breadboard_chat_seeded', { lastPushId });
  }

  function beginTurn(text) {
    const m = /\[\[bbchat:(\d+):(\d+)\]\]/.exec(String(text ?? ''));
    if (!m || !armed || Number(m[1]) !== armed.id) return;
    capture = { roomId: armed.roomId, body: '' };
    clearTimeout(captureTimer);
    captureTimer = setTimeout(() => {
      log('breadboard_chat_timeout', { push: armed?.id, room: armed?.roomId });
      capture = null;
      armed = null;
    }, CAPTURE_MS);
    captureTimer.unref?.();
  }

  /** The overlay stream: text deltas add up to the answer, done ends the turn. */
  function observe(msg) {
    if (!capture || msg?.kind !== 'agent') return;
    const e = msg.e ?? {};
    if (e.type === 'text' && typeof e.text === 'string') capture.body += e.text;
    else if (e.type === 'done') finish('done');
    else if (e.type === 'error') finish('error');
  }

  async function finish(why) {
    const turn = capture;
    const job = armed;
    capture = null;
    armed = null;
    clearTimeout(captureTimer);
    if (!turn || !job) return;
    const body = clip(turn.body.replace(/\[\[bbchat:\d+:\d+\]\]/g, '')).trim();
    if (!body) {
      log('breadboard_chat_empty', { push: job.id, room: job.roomId, why });
      await ack(job.id);
      return;
    }
    let sent = false;
    for (let attempt = 1; attempt <= 3 && !sent; attempt++) {
      try {
        await api('POST', '/api/chat/messages', { body, room: String(job.roomId), agent_name: agent });
        sent = true;
      } catch (e) {
        log('breadboard_chat_send_error', { push: job.id, attempt, error: String(e.message).slice(0, 160) });
        await new Promise((r) => setTimeout(r, 1500 * attempt));
      }
    }
    if (sent) {
      log('breadboard_chat_replied', { push: job.id, room: job.roomId, chars: body.length });
      await ack(job.id);
    }
  }

  async function ack(upTo) {
    try {
      await api('POST', '/api/chat/pushes/ack', { up_to: upTo, agent_name: agent });
      writeState({ lastPushId, seeded });
    } catch (e) {
      log('breadboard_chat_ack_error', { error: String(e.message).slice(0, 160) });
    }
  }

  async function poll() {
    if (stopped || polling || !seeded) return;
    polling = true;
    try {
      // One conversation at a time: the next ping waits until this answer is posted.
      if (armed) return;
      const pushes = await api('GET', `/api/chat/pushes?agent=${encodeURIComponent(agent)}&after=${lastPushId}&limit=20`);
      lastPollError = '';
      if (!Array.isArray(pushes) || !pushes.length) return;
      const push = pushes[0];
      lastPushId = push.id;
      // Persist before answering, so a crash or a failed ack cannot make the same ping answer twice.
      writeState({ lastPushId, seeded });
      const m = push.message ?? {};
      const author = String(m.author_display ?? '').trim();
      const room = String(push.room_name ? `#${push.room_name}` : 'DM');
      if (!author || author.toLowerCase() === agent.toLowerCase() || m.author_member === `agent:${agent}`) {
        await ack(push.id);
        return;
      }
      const body = clip(m.body || (m.attachments?.length ? '(an attachment)' : ''), 2000);
      armed = { id: push.id, roomId: push.room_id, roomName: push.room_name, author };
      const text = [
        `(Breadboard chat for JARVIS [[bbchat:${push.id}:${push.room_id}]]`,
        `${author} in ${room} said: "${body}"`,
        `Reply to ${author} now. Your whole answer is posted to that room word for word, so write only the reply: no preamble, no narration, no note that this came from the system. Keep it brief.)`,
      ].join('\n');
      log('breadboard_chat_ping', { push: push.id, room: room, author, chars: body.length });
      enqueue(text);
    } catch (e) {
      const error = String(e.message).slice(0, 160);
      if (error !== lastPollError) {
        lastPollError = error;
        log('breadboard_chat_poll', { error });
      }
    } finally {
      polling = false;
    }
  }

  async function start() {
    try {
      await register();
      if (!seeded) await seed();
    } catch (e) {
      log('breadboard_chat_start_error', { error: String(e.message).slice(0, 160) });
      // Keep trying: the token, network or name may come back.
    }
    pollTimer = setInterval(poll, POLL_MS);
    pollTimer.unref?.();
    registerTimer = setInterval(() => register().catch((e) => log('breadboard_chat_register_error', { error: String(e.message).slice(0, 160) })), REGISTER_RETRY_MS);
    registerTimer.unref?.();
    setTimeout(poll, 1500).unref?.();
  }

  function stop() {
    stopped = true;
    clearInterval(pollTimer);
    clearInterval(registerTimer);
    clearTimeout(captureTimer);
  }

  return { start, stop, poll, register, beginTurn, observe, get lastPushId() { return lastPushId; } };
}
