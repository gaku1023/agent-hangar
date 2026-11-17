// toml-test（https://github.com/toml-lang/toml-test、MIT）の TOML 1.0 の試験集を 1 つの JSON に束ねる。
// 使い方：node scripts/vendor-toml-test.mjs <toml-test の checkout> 。出力は test/fixtures/toml-test-1.0.0.json。
// 束ねるのは、各ファイルが CRLF や制御文字を含み、git の改行の正規化に壊されるため。
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = process.argv[2];
if (!root) throw new Error('toml-test の checkout を渡してください');
const tests = path.join(root, 'tests');
const list = fs.readFileSync(path.join(tests, 'files-toml-1.0.0'), 'utf8').split('\n').filter((f) => f.endsWith('.toml'));
const out = { source: 'toml-lang/toml-test', commit: execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), toml: '1.0.0', valid: {}, invalid: {} };
for (const f of list) {
  const [kind, ...rest] = f.split('/');
  out[kind][rest.join('/')] = fs.readFileSync(path.join(tests, f)).toString('latin1');
}
fs.writeFileSync(new URL('../test/fixtures/toml-test-1.0.0.json', import.meta.url), `${JSON.stringify(out, null, 1)}\n`);
