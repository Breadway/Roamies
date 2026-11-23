// Linux hands tools against a fake helper: windows grouped by workspace, window_control, pointer_drag,
// text-only read_window, browser tab steps and the hyprctl refusal. Run: npm test
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

if (process.platform !== 'linux') { console.log('hands linux tests: skipped (Linux only)'); process.exit(0); }
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roamies-hands-linux-test-'));
const log = path.join(dir, 'calls.jsonl'), fake = path.join(dir, 'hands.mjs');
fs.writeFileSync(fake, `import fs from 'node:fs'; const a = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(a) + '\\n');
const win = { id: 7, app: 'Zen', title: 'Docs', bounds: [0, 0, 1000, 800] };
const wins = { ok: true, activeWorkspace: 2, windows: [
  { id: 7, app: 'Zen', title: 'Docs', workspace: 2, frontApp: true, fullscreen: 0, floating: false,
    zen: { active: 'Work', spaces: [{ name: 'Work', active: true, tabs: [{ title: 'Docs', url: 'https://example.test/docs', current: true }] }, { name: 'Later', active: false, tabs: [{ title: 'Mail' }] }] } },
  { id: 8, app: 'Term', title: 'shell', workspace: 1, fullscreen: 2, floating: true },
] };
let o = { ok: true, window: win };
if (a[0] === 'windows') o = wins;
if (a[0] === 'wm') { const p = JSON.parse(a[1]); o = p.action === 'list' ? wins : { ok: true, text: p.action === 'monitors' ? 'eDP-1 1920x1200' : '1 2' }; }
if (a[0] === 'pointer') o = { ok: true, done: 'dragged 24 steps' };
if (a[0] === 'ui') o = { ok: true, window: win, controls: [], texts: ['Hello from the page'], note: '' };
if (a[0] === 'act') o = { ok: true, done: JSON.parse(a[1]).steps.map((s) => s.do), window: win };
if (a[0] === 'capture') { fs.writeFileSync(a[1], 'x'); o = { ok: true, file: a[1], window: win, pixels: [1000, 800] }; }
if (a[0] === 'locate') o = { ok: true, window: win };
console.log(JSON.stringify(o));
`);
process.env.ROAMIES_HANDS = fake;
process.env.HYPRLAND_INSTANCE_SIGNATURE = 'test';

const { createTools } = await import('../tools.mjs');
const { canSnap } = await import('../platform.mjs');
const noop = () => {};
const made = createTools({ allowActions: () => true, ui: noop, ask: async () => false, openUrl: noop, onCommitments: noop, showList: noop, fmtWhen: String, commitmentsText: () => '', userName: 'Test' });
const tool = (n) => made.tools.find((t) => t.name === n);
const calls = () => fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
const ctx = { toolCallId: 't1' };

assert.equal(canSnap('linux', fake), true, 'with the helper, asking about an area works on Linux');
assert.equal(canSnap('linux', ''), false, 'without it, it does not');

const windows = await tool('list_windows').execute({});
assert.match(windows, /Workspace 1:/);
assert.match(windows, /Workspace 2 \(current\):/);
assert.match(windows, /window:8 {2}Term — shell {2}\(fullscreen\) {2}\(floating\)/);
assert.match(windows, /window:7 {2}Zen — Docs {2}\(frontmost app\)/);
assert.doesNotMatch(windows, /Zen workspace|Later: Mail|https:\/\/example\.test\/docs/, 'tab titles and addresses are not sent');

assert.equal(await tool('window_control').execute({ action: 'list' }), windows);
fs.writeFileSync(log, '');
assert.equal(await tool('window_control').execute({ action: 'focus', window: '7' }), '1 2');
assert.deepEqual(calls().find((c) => c[0] === 'wm'), ['wm', '{"action":"focus","window":"7"}']);

assert.equal(await tool('pointer_drag').execute({ from: [10, 20], to: [30, 40] }), 'dragged 24 steps');
const pointer = calls().find((c) => c[0] === 'pointer');
assert.equal(JSON.parse(pointer[1]).action, 'drag');
assert.deepEqual(JSON.parse(pointer[1]).from, [10, 20]);

assert.match(await tool('read_window').execute({ target: 'front' }), /^Zen — Docs\nText on screen: Hello from the page$/);

fs.writeFileSync(log, '');
const acted = await tool('act_in_app').execute({ target: 'Zen', steps: [{ do: 'tab', text: 'Docs' }] }, ctx);
assert.equal(acted, 'In Zen: tab.');
assert.deepEqual(JSON.parse(calls().find((c) => c[0] === 'act')[1]).steps, [{ do: 'tab', text: 'Docs' }]);

await assert.rejects(tool('run_command').execute({ command: 'hyprctl workspaces' }, ctx), /Use the window tools/);

fs.writeFileSync(log, '');
const shot = await tool('take_screenshot').execute({ target: 'screen' }, ctx);
assert.match(shot.content[0].text, /1000×800 px/);
assert.ok(calls().some((c) => c[0] === 'capture'));
assert.ok(!calls().some((c) => c[0] === 'locate'), 'screen shots need no window lookup');

// Window and pointer actions are off when Allow actions is off, like act_in_app.
{
  const off = createTools({ allowActions: () => false, ui: noop, ask: async () => false, openUrl: noop, onCommitments: noop, showList: noop, fmtWhen: String, commitmentsText: () => '', userName: 'Test' });
  const offTool = (n) => off.tools.find((t) => t.name === n);
  await assert.rejects(offTool('window_control').execute({ action: 'focus', window: '7' }), /switched off/);
  await assert.rejects(offTool('pointer_drag').execute({ from: [1, 2], to: [3, 4] }), /switched off/);
}

// Reading the desktop does not make the overlay click-through; moving or focusing a window does.
{
  const seen = [];
  const t = createTools({ allowActions: () => true, ui: (m) => { if (m.kind === 'hands') seen.push(m.on); }, ask: async () => false, openUrl: noop, onCommitments: noop, showList: noop, fmtWhen: String, commitmentsText: () => '', userName: 'Test' });
  await t.hands('wm', JSON.stringify({ action: 'monitors' }));
  assert.deepEqual(seen, [], 'a read leaves the overlay alone');
  await t.hands('wm', JSON.stringify({ action: 'focus', window: 7 }));
  assert.deepEqual(seen, [true, false], 'a focus borrows the pointer like an act');
}

fs.rmSync(dir, { recursive: true, force: true });
console.log('hands linux tests: passed');
