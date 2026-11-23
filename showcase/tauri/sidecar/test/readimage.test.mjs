// read_image: a picture on disk goes to the model as image content, never as raw bytes, and a text file renamed
// .png is refused. Run: npm test
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTools } from '../tools.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roamies-read-image-'));
const noop = () => {};
const made = createTools({ allowActions: () => false, ui: noop, ask: async () => false, openUrl: noop, onCommitments: noop, showList: noop, fmtWhen: String, commitmentsText: () => '', userName: 'Test' });
const tool = made.tools.find((t) => t.name === 'read_image');
assert.ok(tool, 'read_image is in the tool list');

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=', 'base64');
const file = path.join(dir, 'Addi Screenshots', 'shot.png');
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, png);

const res = await tool.execute({ path: file });
assert.equal(res.content[0].type, 'text');
assert.match(res.content[0].text, /image\/png/);
assert.equal(res.content[1].type, 'image', 'the picture is an image block');
assert.equal(res.content[1].mediaType, 'image/png');
assert.equal(res.content[1].data, png.toString('base64'), 'the bytes are base64 in the image block');
assert.ok(!res.content[0].text.includes(png.toString('base64')), 'the bytes are not also in the text');

// A text file renamed .png is not an image.
const fake = path.join(dir, 'fake.png');
fs.writeFileSync(fake, 'not pixels');
await assert.rejects(() => tool.execute({ path: fake }), /isn't a PNG, JPEG, GIF or WebP image/);

// Missing files and folders get a plain answer.
await assert.rejects(() => tool.execute({ path: path.join(dir, 'missing.png') }), /There's no file at/);
await assert.rejects(() => tool.execute({ path: dir }), /is a folder, not an image/);

// Password and key files stay off limits.
const secret = path.join(dir, '.ssh', 'id_rsa');
fs.mkdirSync(path.dirname(secret), { recursive: true });
fs.writeFileSync(secret, 'key');
await assert.rejects(() => tool.execute({ path: secret }), /passwords or keys/);

fs.rmSync(dir, { recursive: true, force: true });
console.log('read_image tests: passed');
