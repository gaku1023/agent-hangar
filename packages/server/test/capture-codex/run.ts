import fs from 'node:fs';
import path from 'node:path';
import { codexVersionOf } from '../../src/provider/codex/compat/version.ts';
import { extractSchemaSubset, type SchemaSubset } from '../../src/provider/codex/compat/schemaSubset.ts';
import { COMPRESSION_FEATURE, parseFeatureList } from '../../src/provider/codex/compat/storage.ts';
import { shapeOfRollout } from '../../src/provider/codex/compat/rolloutShape.ts';
import {
  codexBin, codexFeaturesText, codexHelpText, codexVersionText, dropWorld, generateSchemaBundle, makeCodexWorld, probeAppServer, PROMPT_TOOL, runMockExec, startMockLlm,
} from '../codexHarness.ts';
import { FIXTURE_CODEX_COMPAT_DIR } from '../codexCompatFixtures.ts';

// codex の見本を採る道具。入口は scripts/capture-codex-fixtures.ts（npm run capture-codex-fixtures）。
// 本物の codex を、試しの置き場（HOME と CODEX_HOME を一時ディレクトリへ）と空の環境で動かす。ログインはせず、モデルも使わない
// （手元の 127.0.0.1 に立てた Responses API の模擬が決まった文を返す）。利用者の ~/.codex には触らず、終わったら置き場ごと消す。
// 照合は codexLive.test.ts（週に 1 度の .github/workflows/codex-compat.yml）。

type Options = { force: boolean; out: string | null };
function parseArgs(argv: string[]): Options {
  const o: Options = { force: false, out: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--force') o.force = true;
    else if (a === '--out') o.out = argv[++i] ?? null;
    else throw new Error(`知らない引数です：${a}（使えるのは --force と --out <ディレクトリ>）`);
  }
  return o;
}

const json = (v: unknown): string => `${JSON.stringify(v, null, 1)}\n`;

/** 控えを、1 つの定義が 1 かたまりになる形で書く（差分が定義ごとに読める）。 */
export function subsetText(s: SchemaSubset): string {
  const block = (o: Record<string, unknown>) => Object.entries(o).map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(',\n');
  return `{\n "methods": {\n${block(s.methods)}\n },\n "definitions": {\n${block(s.definitions)}\n }\n}\n`;
}

export const readmeFor = (version: string, date: string): string => `# codex ${version} の見本

- 採った日：${date}
- 採り方：\`npm run capture-codex-fixtures\`（採り直すときは \`-- --force\`）。空の環境と試しの置き場で、ログインもモデルも使わずに採る。
  手で直さない。

| ファイル | 中身 |
| --- | --- |
| \`version.txt\` | \`codex --version\` の出力。 |
| \`help.txt\` | \`codex --help\` の出力。サブコマンドの一覧（別名も）を、外のターミナルの横取りの一覧と突き合わせる。 |
| \`app-server-schema.json\` | \`codex app-server generate-json-schema\` の束のうち、hangar が使う要求・通知・承認の要求（\`compat/schemaSubset.ts\` の \`HANGAR_CODEX_METHODS\`）の包みと、参照をたどった定義。説明文は入れない。 |
| \`app-server-probe.json\` | ログイン無しの app-server に話した答えのキーの名前（initialize、thread/start、thread/started、thread/resume がターンの前は no rollout found になること）。 |
| \`features.json\` | \`codex features list\` のうち、rollout を zst に切り替える \`local_thread_store_compression\` の段階と既定。既定が true になると、同じ会話が jsonl と zst で名前を変える。 |
| \`rollout-shape.json\` | 模擬のモデルで \`codex exec\` を 2 本（文で答えるターン、道具を呼ぶターン）走らせてできた rollout の、行の種類ごとの形（キーの道と型）。値は入れない。 |

照合の仕組みは docs/design.md の「Codex の互換の見張り」にある。
`;

export async function main(argv: string[]): Promise<void> {
  const o = parseArgs(argv);
  const bin = codexBin();
  if (!bin) throw new Error('codex が見つかりません。HANGAR_CODEX_BIN で場所を渡すか、PATH に入れてください');
  const world = makeCodexWorld(bin, 'hangar-codex-capture-');
  const world2 = makeCodexWorld(bin, 'hangar-codex-capture-');
  let llm: Awaited<ReturnType<typeof startMockLlm>> | null = null;
  try {
    const versionOut = codexVersionText(bin, world.env);
    const version = codexVersionOf(versionOut);
    if (!version) throw new Error(`codex の版を読めません：${versionOut.trim().slice(0, 200)}`);
    const target = o.out ? path.resolve(o.out) : path.join(FIXTURE_CODEX_COMPAT_DIR, version);
    if (fs.existsSync(target) && !o.force) throw new Error(`${target} はもうあります。採り直すときは --force を付けてください`);
    console.log(`codex ${version}（${bin}）の見本を ${target} に採ります`);

    const files = new Map<string, string>();
    files.set('version.txt', versionOut);
    files.set('help.txt', codexHelpText(bin, world.env));
    files.set('app-server-schema.json', subsetText(extractSchemaSubset(generateSchemaBundle(bin, world))));
    files.set('app-server-probe.json', json(await probeAppServer(bin, world)));
    const compression = parseFeatureList(codexFeaturesText(bin, world))[COMPRESSION_FEATURE];
    if (!compression) throw new Error(`codex features list に ${COMPRESSION_FEATURE} がありません`);
    files.set('features.json', json({ [COMPRESSION_FEATURE]: compression }));
    llm = await startMockLlm();
    const turn = await runMockExec(bin, world, llm.port, 'say hi');
    const tool = await runMockExec(bin, world2, llm.port, PROMPT_TOOL);
    files.set('rollout-shape.json', json(shapeOfRollout([...turn.lines, ...tool.lines])));
    files.set('README.md', readmeFor(version, new Date().toISOString().slice(0, 10)));

    // 試しの置き場のパスや利用者のホームが紛れ込んでいないか、書く前に確かめる。
    const leaks = [...files].flatMap(([name, text]) => [world.root, world2.root, process.env.HOME ?? '', process.env.USER ? `/${process.env.USER}/` : ''].filter((s) => s.length > 3 && text.includes(s)).map((s) => `${name} に ${s} が残っています`));
    if (leaks.length > 0) throw new Error(leaks.join('\n'));

    fs.mkdirSync(target, { recursive: true });
    for (const [name, text] of files) fs.writeFileSync(path.join(target, name), text);
    console.log(`書きました：${[...files.keys()].join('、')}`);
  } finally {
    await llm?.close();
    dropWorld(world);
    dropWorld(world2);
  }
}
