// spikes/05-indexer/tail.mjs  追記されるファイルをバイト位置で追い、途中行を次回に回す
import fs from 'node:fs';
const file = process.argv[2]; let pos = Number(process.argv[3] ?? 0), carry = '';
setInterval(() => {
  const st = fs.statSync(file); if (st.size <= pos) return;
  const fd = fs.openSync(file, 'r'); const buf = Buffer.alloc(st.size - pos);
  fs.readSync(fd, buf, 0, buf.length, pos); fs.closeSync(fd);
  const text = carry + buf.toString('utf8'); const parts = text.split('\n');
  carry = parts.pop();                       // 改行で終わっていなければ次回へ
  for (const l of parts) if (l.trim()) {
    try { const r = JSON.parse(l); console.log(new Date().toISOString(), 'rec', r.type, JSON.stringify(r.message?.content?.[0] ?? r.message?.content ?? '').slice(0, 60)); }
    catch { console.log('BAD', l.slice(0, 60)); }
  }
  if (carry) console.log('(partial line held:', carry.length, 'chars)');
  pos = st.size;
}, 300);
