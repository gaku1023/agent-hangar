import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { which } from '../../src/config/tools.ts';
import { captureOutputSync } from '../../src/platform/capture.ts';
import { CLAUDE_CHILD_ENV } from '../../src/provider/claude-code/compat/childEnv.ts';
import { claudeVersionOf } from '../../src/provider/claude-code/compat/cli.ts';
import { mangleCwd } from '../../src/provider/claude-code/discover.ts';
import { Tmux, type TmuxExec } from '../../src/tmux/tmux.ts';
import { leaks, redactAgents, redactAuth, redactRegistry, redactStatusline, redactTranscriptLine, replacements, type Secrets } from './redact.ts';
import { SCENARIO } from './scenario.ts';

// 見本を採る道具。本物の claude を一時ディレクトリで動かすので、Claude の使用量を少し使う。CI では動かさない。
// 動かす前に利用者に聞く。入口は scripts/capture-claude-fixtures.ts（npm run capture-claude-fixtures）。

/** 見本の置き場。版ごとのディレクトリを作る。 */
const FIXTURES = fileURLToPath(new URL('../fixtures/claude', import.meta.url));
/** 専用の tmux サーバの中のセッション名。止めるのはこの名前だけである。 */
const TMUX_SESSION = 'hangar-fixture';
/** 筋書きのどの段も、これより待って進まなければ諦める。 */
const STEP_TIMEOUT_MS = 180_000;
/** claude の読み取りコマンド（--version、agents、auth status、--help、purge）の時間の上限。 */
const CLI_TIMEOUT_MS = 60_000;

const sleep = (ms: number) => new Promise<void>((r) => { setTimeout(r, ms); });
const readText = (file: string): string => { try { return fs.readFileSync(file, 'utf8'); } catch { return ''; } };
const jsonl = (text: string): unknown[] => text.split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l) as unknown);
const toJsonl = (recs: unknown[]): string => recs.map((r) => JSON.stringify(r)).join('\n') + '\n';
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

/**
 * 子の claude と tmux に渡す環境。
 * この道具は Claude Code のセッションの中から動かすことが多い。その親が子に立てる印（CLAUDE_CHILD_ENV の名前）と、外の tmux と IDE を指す変数を外す。
 * 外さないと、採る claude が別のセッションの子として振る舞い、見本の形が変わる。
 * CLAUDE_CONFIG_DIR は、利用者が選んだアカウントの置き場なので残す。
 * 自動更新は止める。採っている途中で版が変わると、見本の版がずれる。
 */
function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of [...CLAUDE_CHILD_ENV, 'TMUX', 'TMUX_PANE', 'CLAUDE_CODE_SSE_PORT']) delete env[k];
  env.DISABLE_AUTOUPDATER = '1';
  return env;
}

async function until(what: string, cond: () => boolean, timeoutMs = STEP_TIMEOUT_MS): Promise<void> {
  const limit = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > limit) throw new Error(`${what}を待ちきれませんでした`);
    await sleep(250);
  }
}

export async function main(argv: string[]): Promise<void> {
  const force = argv.includes('--force');
  const env = childEnv();
  const bin = process.env.HANGAR_CLAUDE_BIN ?? which('claude');
  const tmuxPath = which('tmux');
  if (!bin || !tmuxPath) throw new Error('claude と tmux が要ります');
  // claude は標準出力がパイプだと書き切る前に終わることがある。出力は一時ファイル経由で読む（captureOutputSync）。
  // 起こせないときと時間切れは投げる。
  const claude = (args: string[]): string => captureOutputSync(bin, args, { timeoutMs: CLI_TIMEOUT_MS, env }).stdout;
  const versionText = claude(['--version']);
  const version = claudeVersionOf(versionText);
  if (!version) throw new Error(`claude --version を読めませんでした: ${versionText.trim()}`);
  const outDir = path.join(FIXTURES, version);
  if (fs.existsSync(outDir) && !force) throw new Error(`${outDir} はもうあります。採り直すときは --force を付けてください`);
  const claudeDir = process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-fixture-'));
  const tmpReal = fs.realpathSync(tmp);
  const work = path.join(tmpReal, 'work');
  fs.mkdirSync(work);
  // 専用のソケットを -S で名指しする。exec を自分で渡すのは、上の環境（変数を外したもの）で tmux サーバを起こすためである。
  // -f /dev/null で、利用者の tmux.conf を読ませない。-f はサーバを起こすときだけ効く。
  const exec: TmuxExec = (file, args) => {
    const r = spawnSync(file, ['-f', '/dev/null', ...args], { encoding: 'utf8', env });
    return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error };
  };
  const tmux = new Tmux({ tmuxPath, socketPath: path.join(tmpReal, 'tmux.sock'), exec });
  const sessionId = crypto.randomUUID();
  const projectDir = path.join(claudeDir, 'projects', mangleCwd(work));
  const transcriptFile = path.join(projectDir, `${sessionId}.jsonl`);
  const subagentDir = path.join(projectDir, sessionId, 'subagents');
  const statuslineFile = path.join(tmpReal, 'statusline.jsonl');
  const registryDir = path.join(claudeDir, 'sessions');

  // その会話の登録を、変わるたびに写す。
  const registry: unknown[] = [];
  let lastRegistry: string | null = null;
  const readRegistryText = (): string | null => {
    let names: string[] = [];
    try { names = fs.readdirSync(registryDir); } catch { return null; }
    for (const n of names) {
      if (!n.endsWith('.json')) continue;
      const text = readText(path.join(registryDir, n));
      try { if ((JSON.parse(text) as { sessionId?: unknown }).sessionId === sessionId) return text; } catch { /* 書きかけ */ }
    }
    return null;
  };
  const statusNow = (): string | null => {
    if (lastRegistry === null) return null;
    try { return str((JSON.parse(lastRegistry) as { status?: unknown }).status); } catch { return null; }
  };
  const poll = setInterval(() => {
    const text = readRegistryText();
    if (text !== null && text !== lastRegistry) registry.push(JSON.parse(text));
    lastRegistry = text;
  }, 200);

  // 新しいディレクトリでは最初にフォルダを信頼するかを聞かれる。画面に trust が出たら、既定の答え（信頼する）で Enter を全体で 1 度だけ押す。
  // 登録（レジストリ）は信頼の画面より先に現れることがあるので、トランスクリプトに中身が出るまでのどの待ちでも見る。
  let trusted = false;
  const answerTrust = (): void => {
    if (trusted || readText(transcriptFile) !== '') return;
    if (/trust/i.test(tmux.capturePane(TMUX_SESSION))) { tmux.sendKeys(TMUX_SESSION, 'Enter'); trusted = true; }
  };
  /** トランスクリプトに中身が出るまでの待ち。待つあいだ、信頼の画面に答える。 */
  const untilWithTrust = (what: string, cond: () => boolean, timeoutMs?: number): Promise<void> => until(what, () => { answerTrust(); return cond(); }, timeoutMs);

  try {
    // statusline に渡る JSON を 1 行ずつ写すスクリプト。利用者の settings.json には触れず、--settings で差し込む。
    const writer = path.join(tmpReal, 'statusline.mjs');
    fs.writeFileSync(writer, [
      "import fs from 'node:fs';",
      "let s = '';",
      "process.stdin.on('data', (d) => { s += d; }).on('end', () => { fs.appendFileSync(process.argv[2], JSON.stringify(JSON.parse(s)) + '\\n'); process.stdout.write('fixture'); });",
      '',
    ].join('\n'));
    const settingsFile = path.join(tmpReal, 'settings.json');
    fs.writeFileSync(settingsFile, JSON.stringify({ statusLine: { type: 'command', command: [process.execPath, writer, statuslineFile].map((p) => JSON.stringify(p)).join(' ') } }));

    tmux.newSession({
      name: TMUX_SESSION, cwd: work, width: 200, height: 50,
      // 可変長の引数（--allowedTools、--mcp-config）は次の引数で閉じるように並べ、指示は最後に置く（spike 02）。
      command: [
        bin, '--allowedTools', ...SCENARIO.tools, '--mcp-config', '{"mcpServers":{}}', '--strict-mcp-config',
        '--setting-sources', 'project', '--disable-slash-commands', '--permission-mode', 'dontAsk',
        '--model', 'haiku', '--effort', 'low', '--settings', settingsFile, '--session-id', sessionId, '-n', SCENARIO.name,
        SCENARIO.first,
      ],
    });
    await untilWithTrust('claude の起動', () => {
      if (!tmux.hasSession(TMUX_SESSION)) throw new Error('claude が起動の途中で終わりました。引数が通らなかった可能性があります');
      return lastRegistry !== null;
    }, 60_000);
    // 1 つ目の指示の Bash（sleep 20）が走っている間に、2 つ目の指示を打って積む。
    await untilWithTrust('Bash の sleep', () => readText(transcriptFile).includes('sleep 20'));
    await sleep(2000);
    tmux.sendKeys(TMUX_SESSION, '-l', SCENARIO.queued);
    await sleep(500);
    tmux.sendKeys(TMUX_SESSION, 'Enter');
    // サブエージェントが走り、休みが 5 秒続いたら筋書きは終わり。
    let idleSince: number | null = null;
    await until('サブエージェントと休み', () => {
      const done = readText(transcriptFile).includes('"name":"Agent"') && fs.existsSync(subagentDir);
      idleSince = statusNow() === 'idle' ? (idleSince ?? Date.now()) : null;
      return done && idleSince !== null && Date.now() - idleSince >= 5000;
    }, 300_000);
    // 対話のセッションは動いているあいだだけ agents --json に並ぶので、終える前に読む。
    // 起こせない、時間切れのときは空として扱う。下の筋書きの確かめで、この会話の行が無いとして落ちる。
    const agentsText = (() => { try { return claude(['agents', '--json', '--all']); } catch { return ''; } })();
    // 終える。/exit が効かなければ Ctrl+C を 2 回送る。
    tmux.sendKeys(TMUX_SESSION, '-l', '/exit');
    await sleep(300);
    tmux.sendKeys(TMUX_SESSION, 'Enter');
    try {
      await until('終了', () => readRegistryText() === null, 20_000);
    } catch {
      tmux.sendKeys(TMUX_SESSION, 'C-c');
      await sleep(500);
      tmux.sendKeys(TMUX_SESSION, 'C-c');
      await until('終了', () => readRegistryText() === null, 20_000);
    }
    await sleep(2000);

    const transcriptText = readText(transcriptFile);
    const subagents = (fs.existsSync(subagentDir) ? fs.readdirSync(subagentDir) : []).filter((n) => /^agent-[0-9a-zA-Z]+\.jsonl$/.test(n)).sort();
    const statusline = jsonl(readText(statuslineFile));
    const agentsRows: unknown = (() => { try { return JSON.parse(agentsText); } catch { return []; } })();
    const authText = claude(['auth', 'status', '--json']);
    const auth = JSON.parse(authText) as Record<string, unknown>;
    const helpText = claude(['--help']);
    const secrets: Secrets = {
      tmp, tmpReal, tmpRoot: os.tmpdir(), tmpRootReal: fs.realpathSync(os.tmpdir()),
      home: os.homedir(), claudeDir, user: os.userInfo().username, host: os.hostname(),
      email: str(auth.email), orgName: str(auth.orgName), orgId: str(auth.orgId),
    };
    const pairs = replacements(secrets);

    // 筋書きが通ったかを確かめる。足りなければ書き出さない。
    const problems: string[] = [];
    if (transcriptText === '') problems.push('トランスクリプトがありません');
    if (subagents.length === 0) problems.push('サブエージェントのトランスクリプトがありません');
    if (!transcriptText.includes(SCENARIO.queued)) problems.push('積んだ指示がトランスクリプトにありません');
    if (registry.length < 2) problems.push('レジストリの写しが 2 つ未満です');
    if (statusline.length === 0) problems.push('statusline の JSON が届いていません（--settings の statusLine が効いていません）');
    if (redactAgents(agentsRows, sessionId, pairs).length === 0) problems.push('agents --json にこの会話がありません');
    if (problems.length > 0) throw new Error(`筋書きが通りませんでした:\n- ${problems.join('\n- ')}`);

    const files: Record<string, string> = {
      'transcript.jsonl': toJsonl(jsonl(transcriptText).map((r) => redactTranscriptLine(r, pairs))),
      'registry.jsonl': toJsonl(registry.map((r) => redactRegistry(r, pairs))),
      'statusline.jsonl': toJsonl(statusline.map((r) => redactStatusline(r, pairs))),
      'agents.json': JSON.stringify(redactAgents(agentsRows, sessionId, pairs), null, 2) + '\n',
      'auth-status.json': JSON.stringify(redactAuth(auth, pairs), null, 2) + '\n',
      'help.txt': helpText,
      'version.txt': versionText,
      'meta.json': JSON.stringify({ version, sessionId, capturedAt: new Date().toISOString().slice(0, 10) }, null, 2) + '\n',
    };
    for (const n of subagents) files[`subagents/${n}`] = toJsonl(jsonl(readText(path.join(subagentDir, n))).map((r) => redactTranscriptLine(r, pairs)));
    const found = Object.entries(files).flatMap(([name, text]) => leaks(text, secrets).map((what) => `${name}: ${what}`));
    if (found.length > 0) throw new Error(`伏せ残しがあるので書き出しません:\n- ${found.join('\n- ')}`);

    fs.rmSync(outDir, { recursive: true, force: true });
    for (const [name, text] of Object.entries(files)) {
      const f = path.join(outDir, name);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, text);
    }
    console.log(`${outDir} に書き出しました。`);
    for (const name of Object.keys(files).sort()) console.log(`  ${name}`);
    console.log('コミットする前に、伏せ残しが無いかを目で確かめてください。');
  } finally {
    clearInterval(poll);
    // 名指しのソケットの名指しのセッションだけを止める。kill-server は呼ばない。
    if (tmux.hasSession(TMUX_SESSION)) tmux.killSession(TMUX_SESSION);
    // その会話の記録を設定の置き場から消す。--all は決して渡さない。名指しのパスが一時ディレクトリの下であることを確かめてから渡す。
    // purge が投げても（起こせない、時間切れ）、次の一時ディレクトリの削除まで必ず進む。
    if (work.startsWith(tmpReal + path.sep)) {
      try {
        const r = captureOutputSync(bin, ['purge', work, '-y'], { timeoutMs: CLI_TIMEOUT_MS, env, stderr: true });
        if (r.code !== 0) console.error(`claude purge が失敗しました。手で消してください: claude purge ${work} -y\n${r.stderr}`);
      } catch (e) {
        console.error(`claude purge を動かせませんでした。手で消してください: claude purge ${work} -y\n${e instanceof Error ? e.message : String(e)}`);
      }
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
