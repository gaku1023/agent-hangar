// spikes/05-indexer/index.mjs
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';

const root = path.join(os.homedir(), '.claude', 'projects');
const db = new Database(path.join(process.cwd(), 'spike.db'));
db.pragma('journal_mode = WAL');
db.exec(`
  drop table if exists ev; drop table if exists fts;
  create table ev (session_id text, seq integer, kind text, ts integer, off integer, len integer, tool_name text, file_path text);
  create virtual table fts using fts5(session_id unindexed, seq unindexed, role, text, tokenize='trigram');
`);
const insEv = db.prepare('insert into ev values (?,?,?,?,?,?,?,?)');
const insFts = db.prepare('insert into fts values (?,?,?,?)');

export function extractText(rec) {
  const m = rec.message; if (!m || !Array.isArray(m.content)) return [];
  const out = [];
  for (const c of m.content) {
    if (c.type === 'text' && c.text) out.push({ role: rec.type, text: c.text });
    if (c.type === 'tool_use') {
      const fp = c.input?.file_path ?? c.input?.path ?? c.input?.command ?? '';
      out.push({ role: 'tool', text: `${c.name} ${fp}`.trim(), tool: c.name, file: c.input?.file_path ?? null });
    }
  }
  return out;
}

const t0 = Date.now(); let files = 0, lines = 0, bad = 0, bytes = 0, maxLine = 0;
const kinds = new Map();
const tx = db.transaction((file, sid) => {
  const buf = fs.readFileSync(file); bytes += buf.length;
  let off = 0, seq = 0;
  while (off < buf.length) {
    let nl = buf.indexOf(10, off); if (nl === -1) nl = buf.length;
    const line = buf.subarray(off, nl); const len = nl - off;
    if (len > maxLine) maxLine = len;
    if (len > 1) {
      lines++;
      try {
        const rec = JSON.parse(line.toString('utf8'));
        const ts = rec.timestamp ? Date.parse(rec.timestamp) : null;
        const parts = extractText(rec);
        const k = rec.type ?? 'unknown'; kinds.set(k, (kinds.get(k) ?? 0) + 1);
        insEv.run(sid, seq, k, ts, off, len, parts.find(p => p.tool)?.tool ?? null, parts.find(p => p.file)?.file ?? null);
        for (const p of parts) insFts.run(sid, seq, p.role, p.text.slice(0, 20000));
        seq++;
      } catch { bad++; }
    }
    off = nl + 1;
  }
});
let subFiles = 0, subBytes = 0;
for (const proj of fs.readdirSync(root)) {
  const pd = path.join(root, proj);
  if (!fs.statSync(pd).isDirectory()) continue;
  for (const f of fs.readdirSync(pd)) {
    const fp = path.join(pd, f);
    if (f.endsWith('.jsonl')) {
      files++; tx(fp, f.replace('.jsonl', ''));
      if (files % 50 === 0) console.log(files, 'files', ((Date.now() - t0) / 1000).toFixed(1), 's');
    } else if (fs.statSync(fp).isDirectory() && fs.existsSync(path.join(fp, 'subagents'))) {
      for (const g of fs.readdirSync(path.join(fp, 'subagents'))) {
        if (!g.endsWith('.jsonl')) continue;
        const gp = path.join(fp, 'subagents', g);
        subFiles++; subBytes += fs.statSync(gp).size; files++;
        tx(gp, f + '/' + g.replace('.jsonl', ''));          // 親セッション ID / agent-xxx
      }
    }
  }
}
console.log('subagent files', subFiles, 'mb', (subBytes / 1e6).toFixed(0));
console.log(JSON.stringify({ files, lines, bad, maxLineMb: (maxLine / 1e6).toFixed(1), mb: (bytes / 1e6).toFixed(0),
  sec: ((Date.now() - t0) / 1000).toFixed(1), dbMb: (fs.statSync('spike.db').size / 1e6).toFixed(0) }));
console.log('kinds', JSON.stringify([...kinds.entries()].sort((a, b) => b[1] - a[1])));
const q = db.prepare("select session_id, count(*) n from fts where text match ? group by session_id order by n desc limit 5");
for (const term of ['動画 チャンネル', 'agent-hangar', 'statusline']) {
  const t = Date.now(); const r = q.all(term.split(/\s+/).map(w => '"' + w.replace(/"/g, '""') + '"').join(' ')); console.log('search', JSON.stringify(term), r.length, 'sessions', Date.now() - t, 'ms', JSON.stringify(r.slice(0, 2)));
}
