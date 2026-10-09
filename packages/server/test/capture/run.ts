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
import { buildFiles, findLeaks, formatLeaks, jsonl, scenarioKept } from './output.ts';
import { redactAgents, redactText, replacements, type Pairs, type Secrets } from './redact.ts';
import { PLACEHOLDER, SCENARIO } from './scenario.ts';
import { createTrustAnswerer, screenClues } from './trust.ts';
import { failureSummary, hasBashSleep } from './transcript.ts';

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
/** 後始末で、claude を止めたあとに登録が消えるのを待つ上限。 */
const UNREGISTER_WAIT_MS = 10_000;

const sleep = (ms: number) => new Promise<void>((r) => { setTimeout(r, ms); });
const readText = (file: string): string => { try { return fs.readFileSync(file, 'utf8'); } catch { return ''; } };
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
/** 利用者の CLAUDE.md の行（前後の空白を除いて 20 文字以上、重複なし）。見本に残っていないかを見る網に使う。値はどこにも書かない。 */
function contextLinesOf(claudeDir: string): string[] {
  const lines = readText(path.join(claudeDir, 'CLAUDE.md')).split('\n').map((l) => l.trim()).filter((l) => l.length >= 20);
  return [...new Set(lines)];
}
const lineCount = (text: string): number => text.split('\n').filter((l) => l.trim() !== '').length;

/** 受けたら中断する信号。中断の旗を立てるだけで、止めるのは待ちの側（後始末が走るように）。 */
const ABORT_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;

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
  // 末尾の / などで置き換えが崩れないように、正規化する。
  const claudeDir = path.resolve(process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude'));
  // 会話を始める（使用量を使う）前に、読めるものを読む。ここで落ちれば、使用量は使わない。
  const authText = claude(['auth', 'status', '--json']);
  const auth = ((): Record<string, unknown> => {
    try {
      const v: unknown = JSON.parse(authText);
      if (typeof v === 'object' && v !== null && !Array.isArray(v)) return v as Record<string, unknown>;
    } catch { /* 下で投げる */ }
    throw new Error('claude auth status --json の出力を JSON のオブジェクトとして読めませんでした');
  })();
  const helpText = claude(['--help']);

  const sessionId = crypto.randomUUID();
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

  // 中断の信号を受けたら旗を立てる。待ちがそれを見て投げ、下の finally が走る（claude を止め、purge し、一時ディレクトリを消す）。
  let aborted: NodeJS.Signals | null = null;
  const onSignal = (sig: NodeJS.Signals): void => { aborted ??= sig; };
  for (const sig of ABORT_SIGNALS) process.on(sig, onSignal);
  const checkAborted = (what: string): void => {
    if (aborted !== null) throw new Error(`${aborted} を受けたので中断しました（${what} の途中）`);
  };

  // 後始末が見る。try の中で作るので、作る前に投げたときは空のままである。
  let tmp: string | null = null;
  let tmpReal: string | null = null;
  let work: string | null = null;
  let tmux: Tmux | null = null;
  let poll: NodeJS.Timeout | null = null;

  try {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-fixture-'));
    tmpReal = fs.realpathSync(tmp);
    const real = tmpReal;
    const workDir = path.join(real, 'work');
    fs.mkdirSync(workDir);
    work = workDir;
    // 専用のソケットを -S で名指しする。exec を自分で渡すのは、上の環境（変数を外したもの）で tmux サーバを起こすためである。
    // -f /dev/null で、利用者の tmux.conf を読ませない。-f はサーバを起こすときだけ効く。
    const exec: TmuxExec = (file, args) => {
      const r = spawnSync(file, ['-f', '/dev/null', ...args], { encoding: 'utf8', env });
      return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error };
    };
    const t = new Tmux({ tmuxPath, socketPath: path.join(real, 'tmux.sock'), exec });
    tmux = t;
    const projectDir = path.join(claudeDir, 'projects', mangleCwd(workDir));
    const transcriptFile = path.join(projectDir, `${sessionId}.jsonl`);
    const subagentDir = path.join(projectDir, sessionId, 'subagents');
    const statuslineFile = path.join(real, 'statusline.jsonl');

    poll = setInterval(() => {
      const text = readRegistryText();
      if (text !== null && text !== lastRegistry) registry.push(JSON.parse(text));
      lastRegistry = text;
    }, 200);

    // 新しいディレクトリでは最初にフォルダを信頼するかを聞かれる。2.1.295 ではカーソルが「No, exit」にあるので、
    // 画面を見て、Yes にカーソルがあるときだけ Enter、No にあるときは Down を送る（trust.ts）。
    // 登録（レジストリ）は信頼の画面より先に現れることがあるので、トランスクリプトに中身が出るまでのどの待ちでも見る。
    const trustAnswer = createTrustAnswerer();
    const answerTrust = (): void => {
      if (readText(transcriptFile) !== '') return;
      const key = trustAnswer(t.capturePane(TMUX_SESSION), Date.now());
      if (key !== null) t.sendKeys(TMUX_SESSION, key);
    };
    /** 時間切れのとき、次の失敗の原因が分かるように、画面の手がかりの行を出す。パスは置き換えの値に直す。 */
    const showScreenClues = (): void => {
      const mask: Pairs = [[real, PLACEHOLDER.tmp], [tmp ?? real, PLACEHOLDER.tmp], [os.homedir(), PLACEHOLDER.home]];
      mask.sort((x, y) => y[0].length - x[0].length);
      const lines = screenClues(t.capturePane(TMUX_SESSION)).map((l) => redactText(l, mask));
      console.error(`最後の画面の手がかりの行:\n${lines.length === 0 ? '（なし）' : lines.map((l) => `  ${l}`).join('\n')}`);
    };
    /**
     * 条件が満たされるまで待つ。待つたびに、中断の信号と、claude の tmux セッションが消えていないかを見る。
     * セッションが消えたら、待ちきらずに投げる（goneOk のときは成功とする）。trust は、信頼の画面に答えるか。
     */
    const wait = async (what: string, cond: () => boolean, o: { timeoutMs?: number; trust?: boolean; goneOk?: boolean } = {}): Promise<void> => {
      const limit = Date.now() + (o.timeoutMs ?? STEP_TIMEOUT_MS);
      for (;;) {
        checkAborted(what);
        if (o.trust) answerTrust();
        if (cond()) return;
        if (!t.hasSession(TMUX_SESSION)) {
          if (o.goneOk) return;
          throw new Error(`${what}の途中で claude の tmux セッションが消えました。claude が終わった（引数が通らなかった、落ちた）可能性があります`);
        }
        if (Date.now() > limit) {
          if (o.trust) showScreenClues();
          throw new Error(`${what}を待ちきれませんでした`);
        }
        await sleep(250);
      }
    };
    /** 固定の待ち。待ったあとに中断の信号を見る。 */
    const pause = async (what: string, ms: number): Promise<void> => { await sleep(ms); checkAborted(what); };

    // statusline に渡る JSON を 1 行ずつ写すスクリプト。利用者の settings.json には触れず、--settings で差し込む。
    const writer = path.join(real, 'statusline.mjs');
    fs.writeFileSync(writer, [
      "import fs from 'node:fs';",
      "let s = '';",
      "process.stdin.on('data', (d) => { s += d; }).on('end', () => { fs.appendFileSync(process.argv[2], JSON.stringify(JSON.parse(s)) + '\\n'); process.stdout.write('fixture'); });",
      '',
    ].join('\n'));
    const settingsFile = path.join(real, 'settings.json');
    fs.writeFileSync(settingsFile, JSON.stringify({ statusLine: { type: 'command', command: [process.execPath, writer, statuslineFile].map((p) => JSON.stringify(p)).join(' ') } }));

    t.newSession({
      name: TMUX_SESSION, cwd: workDir, width: 200, height: 50,
      // 可変長の引数（--allowedTools、--mcp-config）は次の引数で閉じるように並べ、指示は最後に置く（spike 02）。
      command: [
        bin, '--allowedTools', ...SCENARIO.tools, '--mcp-config', '{"mcpServers":{}}', '--strict-mcp-config',
        '--setting-sources', 'project', '--disable-slash-commands', '--permission-mode', 'dontAsk',
        '--model', 'haiku', '--effort', 'low', '--settings', settingsFile, '--session-id', sessionId, '-n', SCENARIO.name,
        SCENARIO.first,
      ],
    });
    await wait('claude の起動', () => lastRegistry !== null, { timeoutMs: 60_000, trust: true });
    // 1 つ目の指示の Bash（sleep 20）が走っている間に、2 つ目の指示を打って積む。
    // 利用者の指示の文にも sleep 20 があるので、claude が実際に Bash を呼んだ行（assistant の tool_use）が出るのを待つ。
    await wait('Bash の sleep', () => hasBashSleep(readText(transcriptFile)), { trust: true });
    await pause('Bash の sleep の後', 2000);
    t.sendKeys(TMUX_SESSION, '-l', SCENARIO.queued);
    await pause('積む指示の入力の後', 500);
    t.sendKeys(TMUX_SESSION, 'Enter');
    // サブエージェントが走り、休みが 5 秒続いたら筋書きは終わり。
    let idleSince: number | null = null;
    await wait('サブエージェントと休み', () => {
      const done = readText(transcriptFile).includes('"name":"Agent"') && fs.existsSync(subagentDir);
      idleSince = statusNow() === 'idle' ? (idleSince ?? Date.now()) : null;
      return done && idleSince !== null && Date.now() - idleSince >= 5000;
    }, { timeoutMs: 300_000 });
    // 対話のセッションは動いているあいだだけ agents --json に並ぶので、終える前に読む。
    // 起こせない、時間切れのときは空として扱う。下の筋書きの確かめで、この会話の行が無いとして落ちる。
    const agentsText = (() => { try { return claude(['agents', '--json', '--all']); } catch { return ''; } })();
    // 終える。休みの入力の欄で Ctrl+C を、間を置いて 2 回送ると終わる（/exit は --disable-slash-commands の下では指示として渡り、余計なターンと使用量になる）。
    // 終わるとセッションも消えるので、消えたら成功とする。待ちきれなければ、もう一度 2 回送ってから待つ。
    const interrupt = async (): Promise<void> => {
      t.sendKeys(TMUX_SESSION, 'C-c');
      await pause('Ctrl+C の間', 600);
      t.sendKeys(TMUX_SESSION, 'C-c');
    };
    const exited = (): boolean => readRegistryText() === null;
    await interrupt();
    try {
      await wait('終了', exited, { timeoutMs: 20_000, goneOk: true });
    } catch (e) {
      if (aborted !== null) throw e;
      await interrupt();
      await wait('終了', exited, { timeoutMs: 20_000, goneOk: true });
    }
    await pause('終了の後', 2000);

    const transcriptText = readText(transcriptFile);
    const subagents = (fs.existsSync(subagentDir) ? fs.readdirSync(subagentDir) : []).filter((n) => /^agent-[0-9a-zA-Z]+\.jsonl$/.test(n)).sort();
    const statusline = jsonl(readText(statuslineFile), 'statusline.jsonl');
    const agentsRows: unknown = (() => { try { return JSON.parse(agentsText); } catch { return []; } })();
    const secrets: Secrets = {
      tmp, tmpReal: real, tmpRoot: os.tmpdir(), tmpRootReal: fs.realpathSync(os.tmpdir()),
      home: os.homedir(), claudeDir, user: os.userInfo().username, host: os.hostname(),
      email: str(auth.email), orgName: str(auth.orgName), orgId: str(auth.orgId),
      contextLines: contextLinesOf(claudeDir),
    };
    const pairs = replacements(secrets);

    // 筋書きが通ったかを確かめる。足りなければ書き出さない。落ちたときは、値を含まない要約を標準エラーに出す。
    const agentsKept = redactAgents(agentsRows, sessionId, pairs);
    const problems: string[] = [];
    if (transcriptText === '') problems.push('トランスクリプトがありません');
    if (subagents.length === 0) problems.push('サブエージェントのトランスクリプトがありません');
    if (!transcriptText.includes(SCENARIO.queued)) problems.push('積んだ指示がトランスクリプトにありません');
    if (registry.length < 2) problems.push('レジストリの写しが 2 つ未満です');
    if (statusline.length === 0) problems.push('statusline の JSON が届いていません（--settings の statusLine が効いていません）');
    if (agentsKept.length === 0) problems.push('agents --json にこの会話がありません');
    if (problems.length > 0) {
      console.error(failureSummary([
        ['transcript.jsonl', lineCount(transcriptText)], ['registry.jsonl', registry.length], ['statusline.jsonl', statusline.length], ['agents.json', agentsKept.length],
        ...subagents.map((n): [string, number] => [`subagents/${n}`, lineCount(readText(path.join(subagentDir, n)))]),
      ], transcriptText));
      throw new Error(`筋書きが通りませんでした:\n- ${problems.join('\n- ')}`);
    }

    const files = buildFiles({
      transcript: transcriptText,
      subagents: Object.fromEntries(subagents.map((n) => [n, readText(path.join(subagentDir, n))])),
      registry, statusline, agents: agentsRows, auth, help: helpText, versionText, version, sessionId,
      capturedAt: new Date().toISOString().slice(0, 10),
    }, secrets);
    // 伏せで筋書きの指示が崩れたとき、または伏せ残しがあるときは書き出さない。両方を一度に言う（採り直しを 1 回で済ませるため）。
    // 値は出さず、指示はどちらが無いか、伏せ残しはファイル、行、JSON のパス、種類だけを出す。
    const lost = scenarioKept(files);
    const found = findLeaks(files, secrets);
    if (lost.length > 0 || found.length > 0) {
      console.error(failureSummary(Object.entries(files).map(([name, text]): [string, number] => [name, lineCount(text)]), transcriptText));
      const parts: string[] = [];
      if (lost.length > 0) parts.push(`伏せた後に筋書きの指示が残っていないので書き出しません:\n- ${lost.join('\n- ')}`);
      if (found.length > 0) parts.push(`伏せ残しがあるので書き出しません:\n${formatLeaks(found)}`);
      throw new Error(parts.join('\n'));
    }

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
    if (poll) clearInterval(poll);
    // 名指しのソケットの名指しのセッションだけを止める。kill-server は呼ばない。
    if (tmux?.hasSession(TMUX_SESSION)) tmux.killSession(TMUX_SESSION);
    // claude が登録を消すのを待つ。残ったまま purge すると、動いている会話の記録を消すことになる。待ちきれなくても先へ進む。
    const unregisterLimit = Date.now() + UNREGISTER_WAIT_MS;
    while (readRegistryText() !== null && Date.now() < unregisterLimit) await sleep(250);
    // その会話の記録を設定の置き場から消す。--all は決して渡さない。名指しのパスが一時ディレクトリの下であることを確かめてから渡す。
    // purge が投げても（起こせない、時間切れ）、次の一時ディレクトリの削除まで必ず進む。
    if (work !== null && tmpReal !== null && work.startsWith(tmpReal + path.sep)) {
      try {
        const r = captureOutputSync(bin, ['purge', work, '-y'], { timeoutMs: CLI_TIMEOUT_MS, env, stderr: true });
        if (r.code !== 0) console.error(`claude purge が失敗しました。手で消してください: claude purge ${work} -y\n${r.stderr}`);
      } catch (e) {
        console.error(`claude purge を動かせませんでした。手で消してください: claude purge ${work} -y\n${e instanceof Error ? e.message : String(e)}`);
      }
    }
    if (tmp !== null) fs.rmSync(tmp, { recursive: true, force: true });
    for (const sig of ABORT_SIGNALS) process.off(sig, onSignal);
  }
}
