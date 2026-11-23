// Background shell jobs: start a command that outlives the call (and the app), then poll its output and exit
// status. The child runs in its own process group with its stdio on a log file, and a small wrapper writes the
// exit code to a sibling file, so both remain readable after a sidecar restart.
import { spawn as realSpawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ID = /^j[0-9a-z-]{4,48}$/;
const READ_MAX = 200_000;

const quote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

export function createCommandJobs({ dir, now = Date.now, spawn = realSpawn, log = () => {} } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const jobs = new Map();

  const metaPath = (id) => path.join(dir, `${id}.json`);
  const logPath = (id) => path.join(dir, `${id}.log`);
  const exitPath = (id) => path.join(dir, `${id}.exit`);
  const scriptPath = (id) => path.join(dir, `${id}.sh`);

  function load(id) {
    const key = ID.test(String(id ?? '')) ? String(id) : null;
    if (!key) return null;
    if (jobs.has(key)) return jobs.get(key);
    try {
      const j = JSON.parse(fs.readFileSync(metaPath(key), 'utf8'));
      jobs.set(key, j);
      return j;
    } catch {
      return null;
    }
  }

  function save(j) {
    try { fs.writeFileSync(metaPath(j.id), JSON.stringify(j), { mode: 0o600 }); } catch (e) { log('command_save', { id: j.id, error: String(e.message) }); }
  }

  function newId() {
    for (;;) {
      const id = `j${now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      if (!jobs.has(id) && !fs.existsSync(metaPath(id))) return id;
    }
  }

  function start({ command, cwd, env, title = '' } = {}) {
    const text = String(command ?? '').trim();
    if (!text) throw new Error('The command is empty.');
    const id = newId();
    const script = scriptPath(id), out = logPath(id), exit = exitPath(id);
    // The subshell makes `exit` inside the command only leave the command, never skip the exit-code write.
    fs.writeFileSync(script, `#!/bin/bash\nset -o pipefail\n(\n${text}\n)\n__roamies_code=$?\nprintf '%s' "$__roamies_code" > ${quote(exit)}\nexit "$__roamies_code"\n`, { mode: 0o700 });
    const fd = fs.openSync(out, 'a');
    let child;
    try {
      child = spawn('/bin/bash', [script], {
        cwd: cwd || process.env.HOME,
        env: { ...process.env, ...(env || {}) },
        detached: true,
        stdio: ['ignore', fd, fd],
      });
    } finally {
      fs.closeSync(fd);
    }
    const j = { id, title, command: text, cwd: cwd || process.env.HOME, pid: child.pid, started: now(), log: out, exit, script, status: 'running' };
    jobs.set(id, j);
    save(j);
    child.on('error', (e) => {
      j.error = String(e.message);
      save(j);
      log('command_error', { id, error: j.error });
    });
    child.unref();
    log('command_start', { id, pid: j.pid });
    return { id, pid: j.pid, started: j.started };
  }

  function readExit(j) {
    try {
      const text = fs.readFileSync(j.exit, 'utf8').trim();
      return text === '' ? null : Number(text);
    } catch {
      return null;
    }
  }

  function running(pid) {
    if (!pid) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (e) {
      return e.code === 'EPERM';
    }
  }

  function status(id) {
    const j = load(id);
    if (!j) throw new Error(`No command job ${id} is on record.`);
    const code = readExit(j);
    if (code !== null) {
      if (j.status !== 'done') {
        j.status = 'done';
        j.code = code;
        j.ended = now();
        save(j);
      }
    } else if (!running(j.pid)) {
      if (j.status !== 'lost') {
        j.status = 'lost';
        j.ended = j.ended ?? now();
        save(j);
      }
    }
    const size = fs.statSync(j.log, { throwIfNoEntry: false })?.size ?? 0;
    return {
      id: j.id, title: j.title, status: j.status, code: j.code ?? code,
      pid: j.pid, started: j.started, ended: j.ended ?? null,
      command: j.command, cwd: j.cwd, bytes: size,
    };
  }

  function output(id, { offset = 0, max = 12_000 } = {}) {
    const j = load(id);
    if (!j) throw new Error(`No command job ${id} is on record.`);
    const st = status(id);
    const size = st.bytes;
    let start = Number.isFinite(Number(offset)) ? Math.max(0, Math.trunc(Number(offset))) : 0;
    if (start > size) start = 0; // the log was replaced or shortened
    const want = Math.min(Math.max(1, Math.trunc(Number(max)) || 12_000), READ_MAX, size - start);
    let chunk = '';
    let read = 0;
    if (want > 0) {
      const fd = fs.openSync(j.log, 'r');
      try {
        const buf = Buffer.alloc(want);
        read = fs.readSync(fd, buf, 0, want, start);
        chunk = buf.subarray(0, read).toString('utf8');
      } finally {
        fs.closeSync(fd);
      }
    }
    return { ...st, chunk, nextOffset: start + read, eof: start + read >= size };
  }

  function stop(id) {
    const j = load(id);
    if (!j) throw new Error(`No command job ${id} is on record.`);
    let signalled = false;
    try {
      process.kill(-j.pid, 'SIGTERM');
      signalled = true;
    } catch {
      try { process.kill(j.pid, 'SIGTERM'); signalled = true; } catch {}
    }
    if (signalled) log('command_stop', { id, pid: j.pid });
    return { id, signalled };
  }

  function list() {
    try {
      return fs.readdirSync(dir).filter((n) => n.endsWith('.json')).map((n) => status(n.slice(0, -5))).sort((a, b) => b.started - a.started);
    } catch {
      return [];
    }
  }

  return { start, status, output, stop, list };
}
