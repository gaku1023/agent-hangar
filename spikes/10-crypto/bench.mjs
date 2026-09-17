// spikes/10-crypto/bench.mjs
import { hkdfSync, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import fs from 'node:fs';

const joinSecret = randomBytes(32);
const key = Buffer.from(hkdfSync('sha256', joinSecret, 'hangar-salt-v1', 'hangar-file-v1', 32));
const CHUNK = 1 << 20;   // 1MB ごとに nonce を変える

function encryptFile(src, dst) {
  const inp = fs.openSync(src, 'r'), out = fs.openSync(dst, 'w');
  const buf = Buffer.alloc(CHUNK); let n, idx = 0;
  while ((n = fs.readSync(inp, buf, 0, CHUNK, null)) > 0) {
    const nonce = Buffer.alloc(12); nonce.writeUInt32BE(idx++, 8);
    const c = createCipheriv('aes-256-gcm', key, nonce);
    const body = Buffer.concat([c.update(buf.subarray(0, n)), c.final()]);
    const len = Buffer.alloc(4); len.writeUInt32BE(body.length);
    fs.writeSync(out, Buffer.concat([len, body, c.getAuthTag()]));
  }
  fs.closeSync(inp); fs.closeSync(out);
}
function decryptFile(src, dst) {
  const data = fs.readFileSync(src), out = fs.openSync(dst, 'w'); let p = 0, idx = 0;
  while (p < data.length) {
    const len = data.readUInt32BE(p); p += 4;
    const body = data.subarray(p, p + len); p += len; const tag = data.subarray(p, p + 16); p += 16;
    const nonce = Buffer.alloc(12); nonce.writeUInt32BE(idx++, 8);
    const d = createDecipheriv('aes-256-gcm', key, nonce); d.setAuthTag(tag);
    fs.writeSync(out, Buffer.concat([d.update(body), d.final()]));
  }
  fs.closeSync(out);
}

const src = process.argv[2];
let t = Date.now(); encryptFile(src, '/tmp/spike.enc'); const te = Date.now() - t;
t = Date.now(); decryptFile('/tmp/spike.enc', '/tmp/spike.dec'); const td = Date.now() - t;
const mb = fs.statSync(src).size / 1e6;
console.log(JSON.stringify({ mb: mb.toFixed(0), encMs: te, decMs: td, encMBps: (mb / (te / 1000)).toFixed(0), decMBps: (mb / (td / 1000)).toFixed(0),
  same: fs.readFileSync(src).equals(fs.readFileSync('/tmp/spike.dec')) }));
