// 補助 hangar-voice の偽物。約束（1 行 1 JSON）どおりに台本で返す。
// FAKE_VOICE_MODE: ok（既定。ready を出し、命令に答える）、crash（起動してすぐ落ちる）、garbage（壊れた行を挟んでから ready）、
// malformed（ev を持つが形の合わない行を挟んでから ready）。
const mode = process.env.FAKE_VOICE_MODE ?? 'ok';
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);

if (mode === 'crash') process.exit(1);
if (mode === 'garbage') {
  process.stdout.write('not json\n{"ev":\n[1,2]\n{"nope":1}\n');
}
if (mode === 'malformed') {
  process.stdout.write('{"ev":"micUsers"}\n{"ev":"segment"}\n{"ev":"segment","id":"s","text":3,"dbfs":-30,"ms":1}\n{"ev":"speaking","id":"x","state":"odd"}\n{"ev":"ready"}\n');
}
out({ ev: 'ready', version: 'fake-1' });

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    let c;
    try { c = JSON.parse(line); } catch { continue; }
    if (c.cmd === 'flush') out({ ev: 'flushed' });
    else if (c.cmd === 'speak') { out({ ev: 'speaking', id: c.id, state: 'start' }); out({ ev: 'speaking', id: c.id, state: 'end' }); }
    else if (c.cmd === 'quit') process.exit(0);
  }
});
process.stdin.on('end', () => process.exit(0));
