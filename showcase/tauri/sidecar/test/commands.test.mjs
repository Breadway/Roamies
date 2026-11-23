// Background command jobs: start detached, poll output and exit status, stop, and read them back after a restart.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCommandJobs } from '../commands.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roamies-commands-test-'));
const jobs = createCommandJobs({ dir });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(id, done, ms = 4000) {
  const end = Date.now() + ms;
  for (;;) {
    const s = jobs.status(id);
    if (done(s) || Date.now() > end) return s;
    await wait(40);
  }
}

try {
  const a = jobs.start({ command: "printf 'one\\n'; sleep 0.2; printf 'two\\n'; exit 3", title: 'exit test' });
  assert.match(a.id, /^j/);
  let s = await until(a.id, (x) => x.status !== 'running');
  assert.equal(s.status, 'done');
  assert.equal(s.code, 3);

  const all = jobs.output(a.id, { offset: 0, max: 20000 });
  assert.match(all.chunk, /one/);
  assert.match(all.chunk, /two/);
  assert.equal(all.eof, true);
  assert.equal(all.nextOffset, s.bytes);
  assert.match(jobs.output(a.id, { offset: all.nextOffset }).chunk, /^$/);

  // New output only, from the byte offset the previous read returned.
  const b = jobs.start({ command: "printf 'first\\n'; sleep 0.3; printf 'second\\n'" });
  S: {
    for (let i = 0; i < 60; i++) {
      const r = jobs.output(b.id, { offset: 0 });
      if (r.chunk.includes('first') && !r.chunk.includes('second')) break S;
      await wait(40);
    }
  }
  const first = jobs.output(b.id, { offset: 0 });
  assert.match(first.chunk, /first/);
  const rest = jobs.output(b.id, { offset: first.nextOffset });
  assert.doesNotMatch(rest.chunk, /first/);
  await until(b.id, (x) => x.status !== 'running');

  // A second manager on the same folder reads the stored state, as after an app restart.
  const reopened = createCommandJobs({ dir });
  assert.equal(reopened.status(a.id).code, 3);
  assert.match(reopened.output(a.id).chunk, /two/);

  // Stop a long one: it must not stay running.
  const c = jobs.start({ command: 'sleep 30' });
  await wait(100);
  assert.equal(jobs.status(c.id).status, 'running');
  assert.equal(jobs.stop(c.id).signalled, true);
  s = await until(c.id, (x) => x.status !== 'running', 3000);
  assert.ok(s.status === 'stopped' || s.status === 'lost' || (s.status === 'done' && s.code !== 0), 'a stopped job does not read as a success');

  // An id that was never issued is refused rather than reading an arbitrary file.
  assert.throws(() => jobs.status('../../etc/passwd'), /No command job/);

  // The job must survive the process that started it: a short-lived parent starts it, exits, and a fresh
  // manager (as after an app restart) still sees the output and the exit code.
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'roamies-commands-detach-'));
  const runner = path.join(other, 'start.mjs');
  fs.writeFileSync(runner, `import { createCommandJobs } from ${JSON.stringify(path.resolve('commands.mjs'))};\nconst j = createCommandJobs({ dir: ${JSON.stringify(other)} });\nconsole.log(j.start({ command: "sleep 0.6; echo survived; exit 7" }).id);\n`);
  const started = spawnSync(process.execPath, [runner], { encoding: 'utf8' });
  const id = started.stdout.trim();
  assert.match(id, /^j/);
  await wait(1600);
  const after = createCommandJobs({ dir: other });
  const done = after.status(id);
  assert.equal(done.status, 'done');
  assert.equal(done.code, 7);
  assert.match(after.output(id).chunk, /survived/);
  fs.rmSync(other, { recursive: true, force: true });

  console.log('commands tests: passed');
} finally {
  for (const j of jobs.list()) { try { jobs.stop(j.id); } catch {} }
  fs.rmSync(dir, { recursive: true, force: true });
}
