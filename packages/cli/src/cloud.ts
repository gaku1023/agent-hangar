import { createHash, hkdfSync, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import readline from 'node:readline';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { createGunzip } from 'node:zlib';
import { backfillTranscripts, backupsRoot, cloudConfigPath, type CloudConfig, decryptStream, agentOfSyncPath, AGENT_SYNC, codexHomePath, resolvePhysical, HttpCloudClient, Keyring, openSealedFile, openTranscriptsFloor, parseCloudConfigV2, type WireCloudClient, readCloudConfig, readLegacyCloudConfig, readTranscriptsFrom, remoteRoot, remoteTranscriptPath, saveCloudConfig, SealedCloudClient, sha256Stream } from '@agent-hangar/server/src/cliEntry.ts';
// 同期の本体（暗号、置き場の組み立て、Worker の叩き方）はサーバ側の実装を借りる。
// ここで写しを作ると、鍵の導出やパスの検査が片方だけ直されて食い違う。
import {
  COMPAT_VERSION,
  compatHeaders,
  deriveEpochKeys,
  encodeEpochList,
  formatRecoveryKey,
  generateKeyPair,
  isSafeKeyId,
  isSafeRelPath,
  parseCompat,
  PULL_LIMIT,
  randomEpochKey,
  readCompatRefusal,
  RECOVERY_RECIPIENT,
  sealKeybox,
  sealRoster,
  toBase64Url,
  type KeyboxIn,
  type Roster,
  type SyncStatusDto,
} from '@agent-hangar/shared';
import { DetailedError } from './probe.ts';
import { showAndConfirmRecoveryKey } from './recovery.ts';
import { type CfAccount, defaultExec, type Exec, type ExecResult, isAccountId, parseDatabaseId, parseWhoamiJson, parseWhoamiTable, parseWorkerUrl, type WhoamiResult, WranglerRunner } from './wrangler.ts';

export type DeviceLike = { id: string; name: string; platform: string };

/** 取り返しの付かない操作の確認。合言葉をそのまま打ってもらう。 */
export type ConfirmWord = (question: string, word: string) => Promise<boolean>;

export type SetupCloudOptions = {
  home: string;
  device: DeviceLike;
  /** Worker の名前。D1 は同名、R2 は <name>-files になる。 */
  name?: string;
  wrangler?: WranglerRunner;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  cloudDir?: string;
  log?: (line: string) => void;
  confirm?: ConfirmWord;
  /** 使用量のトークンの問いを出さない。 */
  skipUsageToken?: boolean;
  /** --account-id。作る先の Cloudflare のアカウント ID。 */
  accountId?: string;
  /** CLOUDFLARE_ACCOUNT_ID を読む先。既定は process.env（wrangler に渡す環境は WranglerRunner が作る）。 */
  env?: NodeJS.ProcessEnv;
  /** アカウントを一覧から選ばせてよいか。既定は標準入力が端末かどうか。 */
  interactive?: boolean;
  /** アカウントが複数あるときに選ばせる。null は選ばなかった（中止）。 */
  chooseAccount?: ChooseAccount;
  /** スマホの画面（packages/mobile）を建てる。引数は mobile の置き場。既定は buildMobileApp。試験で差し替える。 */
  buildMobile?: (mobileDir: string) => Promise<void>;
  /** --save。リカバリーキーを 0600 で書くファイル。 */
  saveRecoveryTo?: string;
  /** リカバリーキーの末尾 4 文字を尋ねる。既定は標準入力の askLine。 */
  recoveryAsk?: (question: string) => Promise<string>;
  /** リカバリーキーの表示の書き先。既定は標準出力。 */
  recoveryWrite?: (s: string) => void;
};

/** 複数のアカウントから 1 つを選ばせる。null は選ばなかった。 */
export type ChooseAccount = (accounts: CfAccount[]) => Promise<CfAccount | null>;

/**
 * setup cloud の wrangler の失敗。
 * wrangler の 1 行目は見出し（A request to the Cloudflare API ... failed.）で、本当の理由は後ろの行にあるので、
 * 整えた出力（cleanWranglerError、12 行まで）と案内を複数行のまま見せる（DetailedError）。
 */
export class WranglerStepError extends DetailedError {
  constructor(message: string) {
    super(message);
    this.name = 'WranglerStepError';
  }
}

/**
 * setup の wrangler の失敗に添える一行の案内。当てはまらなければ null。
 * 10042 は R2 が有効でないアカウント、register a workers.dev subdomain は workers.dev のサブドメインが無いアカウントである。
 * wrangler は対話が無いと登録の問いを「いいえ」で抜け、onboarding の URL を添えて止まる（wrangler 4.135 で確かめた）。
 */
export function wranglerHint(text: string): string | null {
  if (/\[code: 10042\]/.test(text)) {
    return '案内: このアカウントでは R2 がまだ有効になっていません。Cloudflare のダッシュボードの R2 の画面で有効にしてから（支払い方法の登録が必要です）、hangar setup cloud をもう一度実行してください。作成済みの D1 はそのまま使います。';
  }
  if (/register a workers\.dev subdomain/i.test(text)) {
    return '案内: このアカウントには workers.dev のサブドメインがまだありません。ダッシュボードの Workers & Pages でサブドメインを設定してから（Worker の URL に表示されるため、メールアドレスや本名と結び付かない名前にしてください）、hangar setup cloud をもう一度実行してください。作成済みの D1 と R2 はそのまま使います。';
  }
  return null;
}

/** setup の初めの R2 の確認で 10042 が返ったときの案内。まだ何も作っていないので、wranglerHint の文とは別にする。 */
const R2_OFF_HINT = '案内: このアカウントでは R2 がまだ有効になっていません。Cloudflare のダッシュボードの R2 の画面で有効にしてください（有効にするには支払い方法の登録が必要です）。Cloudflare にはまだ何も作成していません。有効にしてから hangar setup cloud をもう一度実行してください。';

/** wrangler の失敗を、見出しと整えた出力と案内の複数行にする。 */
function wranglerFailure(what: string, r: ExecResult, hint?: string): WranglerStepError {
  const raw = `${r.stderr}\n${r.stdout}`;
  const reason = cleanWranglerError(raw);
  const lines = [`${what}に失敗しました（wrangler の出力）:`];
  if (reason.length > 0) for (const l of reason) lines.push(`  ${l}`);
  else lines.push(`  （出力がありません。終了コード ${r.code}）`);
  lines.push(hint ?? wranglerHint(raw) ?? '修正してから hangar setup cloud をもう一度実行してください。作成済みの D1 と R2 はそのまま使います。');
  return new WranglerStepError(lines.join('\n'));
}

const HEALTH_TIMEOUT_MS = 120_000;
const HEALTH_INTERVAL_MS = 5000;
const BOOTSTRAP_RETRIES = 6;
/**
 * Worker への 1 回の要求の締め切り。
 * 参加の接続先は人が入力した URL なので、打ち間違いや応答を返さないアドレスのことがある。
 * 待ち続けるより、失敗して何を確認すればよいかを伝える。
 * 反映待ちの再試行（5 秒おきに 6 回）とは別で、これは 1 回ごとに掛かる。
 */
export const WORKER_TIMEOUT_MS = 30_000;

/** 別の名前や別のクラウドへ乗り換えるときの合言葉。前の資源が置き去りになる。 */
export const RENAME_WORD = 'replace';

/**
 * packages/cloud の置き場。
 * HANGAR_CLOUD_DIR があればそこを使う（開発で別の写しを指すための上書き）。
 * 無ければ、この CLI の src からの相対で探す。
 * 配布版の cli.mjs では、この相対は .app の中の存在しない場所を指すので、requireCloudDir が clone を案内して止まる。
 * 配布版に同梱した cloud/ は Worker を束ねたもの（worker.mjs と metadata.json）で、源ではないので、ここでは指さない。
 */
export function defaultCloudDir(): string {
  const fromEnv = process.env.HANGAR_CLOUD_DIR;
  if (fromEnv) return path.resolve(fromEnv);
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../cloud');
}

/**
 * wrangler deploy が読むもの。
 * wrangler だけを見ていると、hono や共有パッケージが無い環境でデプロイの途中で分かりにくく落ちる。
 */
const CLOUD_DEPS: [specifier: string, name: string][] = [
  ['wrangler/package.json', 'wrangler'],
  ['hono', 'hono'],
  ['@agent-hangar/shared', '@agent-hangar/shared'],
];

/**
 * 配布版の cli.mjs の隣にある manifest.json から、アプリの版を読む。
 * 源（packages/cli/src）から動かしているときと、読めないときは null。
 */
export function readAppVersion(dir: string = path.dirname(fileURLToPath(import.meta.url))): string | null {
  try {
    const v = (JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')) as { version?: unknown }).version;
    return typeof v === 'string' && v !== '' ? v : null;
  } catch {
    return null;
  }
}

/**
 * 配布版には Worker の源（packages/cloud）が無い。
 * 存在しないパスを見せても利用者にできることは無いので、パスは出さず、clone してから打つ手順を案内する。
 * version が分かれば、アプリと同じ版を checkout する行を足す。
 */
export function cloudDirMissingMessage(version: string | null): string {
  const lines = [
    'クラウドを作成するには、このリポジトリを clone したディレクトリで実行します（アプリに同梱の hangar には Worker のソースが含まれていません）。',
    '手順:',
    '  git clone https://github.com/gaku1023/agent-hangar.git',
    '  cd agent-hangar',
  ];
  if (version) lines.push(`  git checkout v${version}`);
  lines.push('  npm ci', '  npm run hangar -- setup cloud');
  return lines.join('\n');
}

/**
 * Worker のデプロイに要るものが揃っているかを確かめてから場所を返す。
 * 揃っていなければ、何がどこに無いのかを述べて止める。
 * 黙って wrangler を呼ぶと、意味の分からない終了コードだけが残る。
 *
 * 源（src/index.ts、wrangler.jsonc、package.json）を、依存より先に見る。
 * createRequire の解決は親をたどるので、.app をリポジトリの中や node_modules を持つディレクトリの下に置くと、
 * 無関係な wrangler を拾って依存の検査が素通りし、実物のアカウントに資源を作ってしまう。
 * 配布版に同梱した cloud/ は束ねた worker.mjs だけで源を持たないので、依存を見る前にここで止まる。
 */
export function requireCloudDir(o: { dir?: string; version?: string | null } = {}): string {
  const explicit = o.dir === undefined && !!process.env.HANGAR_CLOUD_DIR;
  const dir = o.dir ?? defaultCloudDir();
  const where = explicit ? 'HANGAR_CLOUD_DIR で指定したパス' : 'この CLI のパスからの相対パス';
  for (const rel of [['src', 'index.ts'], ['wrangler.jsonc'], ['package.json']]) {
    if (!fs.existsSync(path.join(dir, ...rel))) {
      // 利用者が HANGAR_CLOUD_DIR で指した場所なら、そのパスを見せて直させる。そうでなければ clone の手順を案内する。
      if (!explicit) throw new DetailedError(cloudDirMissingMessage(o.version === undefined ? readAppVersion() : o.version));
      throw new Error(`Worker のソース（${rel.join('/')}）が ${dir} にありません（${where}）。クラウド同期の設定と削除は、リポジトリを clone して npm install したディレクトリから実行するか、HANGAR_CLOUD_DIR に packages/cloud のパスを指定してください`);
    }
  }
  let name: string | undefined;
  try {
    name = (JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as { name?: string }).name;
  } catch {
    name = undefined;
  }
  if (name !== '@agent-hangar/cloud') {
    throw new Error(`${dir} は packages/cloud ではありません（${where}。package.json の name は ${name ?? '読み取れません'}）。HANGAR_CLOUD_DIR に packages/cloud のパスを指定してください`);
  }
  for (const [specifier, dep] of CLOUD_DEPS) {
    try {
      createRequire(path.join(dir, 'package.json')).resolve(specifier);
    } catch {
      throw new Error(`${dep} が ${dir} から見つかりません。クラウド同期の設定と削除は、リポジトリを clone して npm install したディレクトリから実行してください`);
    }
  }
  return dir;
}

/** 実物のアカウント ID とデータベース ID を書く先。git に載せないので ~/.agent-hangar の下に置く。 */
export function cloudDirIn(home: string): string {
  return path.join(home, 'cloud');
}

export function wranglerConfigPath(home: string): string {
  return path.join(cloudDirIn(home), 'wrangler.jsonc');
}

/**
 * cloud.json が読めないときの文言。
 * 「まだ参加していない」と混ぜない。
 * この PC の暗号鍵と世代鍵はこのファイルにだけあるので、上書きすると読み取れる見込みも失う。
 */
export function brokenConfigMessage(home: string): string {
  return `${cloudConfigPath(home)} を読み取れません（壊れているか、権限の問題です）。この PC の暗号鍵はこのファイルにだけあり、上書きすると復号できなくなります。ファイルを修正するかバックアップから戻してから、もう一度実行してください。`;
}

/**
 * cloud.json が古い形式（参加トークンを使う版 1）のときの文言。
 * 古い形式の cloud.json は、古いクラウドを片付ける teardown だけが読む。
 * 新しい形式で上書きすると、古いクラウドの Worker の名前と、R2 のトランスクリプトの暗号鍵の材料を失う。
 * Worker を作成した PC には、teardown で古いクラウドを削除してから setup で新しいクラウドを作ることを案内する。
 * 参加しただけの PC は失うものが無いので、新しいクラウドに上書きして参加することを案内する（参加は上書きの前に cloud.json を backups/ に控える）。
 * 手順は docs/cloud-sync.md の「0.9.0 への作り直し」の 3 から 5 と同じである。
 */
export function legacyConfigMessage(home: string): string {
  const creator = readLegacyCloudConfig(home).config?.workerName ?? null;
  const head = `${cloudConfigPath(home)} は 0.8.x までの古い形式の設定です。`;
  if (creator) {
    return `${head}この PC は古いクラウド（Worker ${creator}）を作成した PC です。リポジトリを clone したディレクトリから npm run hangar -- cloud teardown を実行して古いクラウドを削除してから、npm run hangar -- setup cloud で新しいクラウドを作成してください。R2 にしか無いトランスクリプトは、削除の前にこの PC にダウンロードされます。他の PC で古いクラウドを削除済みで、新しいクラウドも作成済みなら、この PC は参加コードで cloud.json を上書きして参加できます（古い設定は、上書きの前に ${backupsRoot(home)} に保存します）。`;
  }
  return `${head}この PC は古いクラウドに参加しただけです。新しいクラウドの参加済みの PC で「PC を追加」をクリックして参加コードを発行し、この PC の 設定 › クラウド同期 の「参加コードで参加」か hangar cloud join <URL> で、cloud.json を上書きして参加してください。古い設定は、上書きの前に ${backupsRoot(home)} に保存します。`;
}

export const sha256Hex = (s: string): string => createHash('sha256').update(s).digest('hex');
const realSleep = (ms: number): Promise<void> => new Promise<void>((r) => setTimeout(r, ms));
const realFetch: typeof fetch = (...a) => fetch(...a);

/**
 * 標準入力を、聞いているあいだだけ掴む。
 * 掴みっぱなしだと、最後の行まで印字してもプロセスが終わらない（実物の片付けで踏んだ）。
 * 手放しっぱなしだと、次の問いを待っているあいだに他に誰も待っていなければ node が終わる。
 * pause だけでは足りず、unref まで要ることは実測で確かめた。
 */
function holdStdin(on: boolean): void {
  const s = process.stdin as NodeJS.ReadStream & { ref?: () => void; unref?: () => void };
  try {
    if (on) s.ref?.();
    else {
      s.pause();
      s.unref?.();
    }
  } catch {
    // 差し替えられた入力では効かないことがある。聞くこと自体は続けられる。
  }
}

/**
 * 標準入力から 1 行だけ聞く。
 * 入力が閉じられている（/dev/null、EOF）ときは空文字を返す。
 * readline の question の callback は EOF では呼ばれないので、close を拾わないと約束が解けないまま
 * node が落ちる。落ちると 中止しました も出ず、終了コードが 0 になって「消えた」と取り違えられる。
 */
export function askLine(prompt: string): Promise<string> {
  // 既に終わっている入力に readline を被せても close すら来ない。先に断る。
  if (process.stdin.readableEnded) {
    process.stdout.write(prompt);
    return Promise.resolve('');
  }
  holdStdin(true);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise<string>((resolve) => {
    let answered = false;
    const done = (a: string): void => {
      if (answered) return;
      answered = true;
      rl.close();
      holdStdin(false);
      resolve(a);
    };
    rl.on('close', () => done(''));
    rl.question(prompt, done);
  });
}

/** 合言葉をそのまま打ってもらう確認。打たれなければ（EOF も）断った扱いにする。 */
export async function promptWord(question: string, word: string): Promise<boolean> {
  return (await askLine(`${question}\n続けるには ${word} と入力してください: `)).trim() === word;
}

/** 標準入力から一度に受け取る上限。参加コードは 9 字なので、これを超える入力は貼り間違いである。 */
const MAX_STDIN_BYTES = 64 * 1024;

/**
 * 参加コードを標準入力から受け取る。
 * argv に載せると ps -axww とシェルの履歴から読めてしまう。
 * 端末なら 1 行を尋ね、パイプなら全部を読む（殻は標準入力で渡す）。
 */
export async function readJoinCodeInput(): Promise<string> {
  if (!process.stdin.isTTY) {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of process.stdin) {
      const b = c as Buffer;
      size += b.length;
      if (size > MAX_STDIN_BYTES) throw new Error('標準入力が長すぎます。参加コードだけを渡してください');
      chunks.push(b);
    }
    return Buffer.concat(chunks).toString('utf8');
  }
  return askLine('参加コードを入力してください（例: K7QM-2XFD）: ');
}

/** Worker の /health の本文。cloudId は Worker が D1 を作ったときに置いた乱数で、作り直した Worker を見分ける。 */
export type HealthBody = { ok: true; version?: string; compat?: number; cloudId?: string };

/** /health が通るまで待ち、本文を返す。デプロイ直後は workers.dev の反映待ちで error code 1042 が返る。通らなければ null。 */
export async function waitForHealthBody(url: string, o: { fetch: typeof fetch; sleep: (ms: number) => Promise<void>; timeoutMs?: number; intervalMs?: number }): Promise<HealthBody | null> {
  const timeout = o.timeoutMs ?? HEALTH_TIMEOUT_MS;
  const interval = o.intervalMs ?? HEALTH_INTERVAL_MS;
  for (let waited = 0; ; waited += interval) {
    try {
      // 1 回の確認が間隔より長引いたら諦める。応答を返さない接続先で待ちが終わらなくなるのを防ぐ。
      const r = await o.fetch(`${url}/health`, { headers: compatHeaders(), signal: AbortSignal.timeout(interval) });
      const body = r.ok ? ((await r.json()) as Partial<HealthBody>) : null;
      if (body?.ok === true) return body as HealthBody;
    } catch {
      // 接続できないうちも、確認が長引いたときも待つ。
    }
    if (waited + interval > timeout) return null;
    await o.sleep(interval);
  }
}

/** /health が通るまで待つ。 */
export async function waitForHealth(url: string, o: { fetch: typeof fetch; sleep: (ms: number) => Promise<void>; timeoutMs?: number; intervalMs?: number }): Promise<boolean> {
  return (await waitForHealthBody(url, o)) !== null;
}

/**
 * Worker との話の失敗の種類。殻と画面は、この符号で言い方を選ぶ（CLI の文は日本語のままなので、画面は辞書の文を出す）。
 * forbidden は最初の端末トークンが通らない、compat は版が合わない、network は接続できない、timeout は応答が無い、
 * failed はそれ以外（待っても 503 のまま、など）である。
 */
export type JoinErrorCode = 'forbidden' | 'compat' | 'network' | 'timeout' | 'failed';

/**
 * Worker との話の失敗。message は CLI の文で、トークンも応答の本文も載せない。
 * causeCode は、network のときにシステムが返した符号（ENOTFOUND、ECONNRESET など）で、分からなければ null である。
 */
export class JoinError extends Error {
  constructor(readonly code: JoinErrorCode, message: string, readonly causeCode: string | null = null) {
    super(message);
    this.name = 'JoinError';
  }
}

/** 接続の失敗の例外から、システムの符号（cause.code）を取り出す。 */
function causeCodeOf(e: unknown): string | null {
  const cause = (e as { cause?: { code?: unknown } } | null)?.cause;
  return typeof cause?.code === 'string' ? cause.code : null;
}

/** 例外から、ユーザーに見せてよい短い手がかりだけを取り出す。本文も秘密も出さない。 */
function reasonOf(e: unknown): string {
  return causeCodeOf(e) ?? (e instanceof Error ? e.name : 'unknown');
}

/** 426 の本文から、Worker が求める版を読んで文にする。本文が流れてこない相手でも締め切りで打ち切る。 */
async function compatRefusal(r: Response, timeout: number): Promise<JoinError> {
  let bodyTimer: ReturnType<typeof setTimeout> | undefined;
  const body = await Promise.race([
    r.text().catch(() => ''),
    new Promise<string>((resolve) => {
      bodyTimer = setTimeout(() => { void r.body?.cancel().catch(() => {}); resolve(''); }, timeout);
      bodyTimer.unref?.();
    }),
  ]);
  clearTimeout(bodyTimer);
  const need = readCompatRefusal(body);
  const want = need === null ? 'それより新しいバージョン' : `${need} 以上`;
  return new JoinError('compat', `この PC の hangar が古いため、クラウドに接続できません（この PC の互換バージョンは ${COMPAT_VERSION}、Worker が必要とするのは ${want}）。hangar を新しいバージョンに更新してから、もう一度実行してください`);
}

/**
 * Worker に 1 回だけ要求を出す。
 * 版の見出しを載せ、token があれば Bearer で送る。締め切りは 1 回ごとに掛ける。
 * 接続の失敗と打ち切りは JoinError（network、timeout）で、426 は JoinError（compat）で投げる。ほかの応答はそのまま返す。
 * redirect を渡すと fetch にそのまま渡す（'manual' なら 3xx をそのまま返す）。省けば fetch の既定（追う）である。
 * トークンは文面に載せない。
 */
export async function workerFetch(url: string, path: string, o: { fetch: typeof fetch; method?: string; body?: unknown; token?: string; timeoutMs?: number; redirect?: RequestRedirect }): Promise<Response> {
  const timeout = o.timeoutMs ?? WORKER_TIMEOUT_MS;
  const ac = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ac.abort(); }, timeout);
  timer.unref?.();
  const headers: Record<string, string> = { ...compatHeaders() };
  if (o.body !== undefined) headers['content-type'] = 'application/json';
  if (o.token) headers.authorization = `Bearer ${o.token}`;
  let r: Response;
  try {
    r = await o.fetch(`${url}${path}`, { method: o.method ?? 'GET', headers, ...(o.body !== undefined ? { body: JSON.stringify(o.body) } : {}), ...(o.redirect ? { redirect: o.redirect } : {}), signal: ac.signal });
  } catch (e) {
    if (timedOut) throw new JoinError('timeout', `${url} が ${timeout} ミリ秒以内に応答しませんでした。接続先が正しいか、${url}/health が応答するかを確認してください`);
    throw new JoinError('network', `${url} に接続できませんでした（${reasonOf(e)}）`, causeCodeOf(e));
  } finally {
    clearTimeout(timer);
  }
  if (r.status === 426) throw await compatRefusal(r, timeout);
  return r;
}

export type BootstrapOptions = {
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  retries?: number;
  /** 1 回の要求の締め切り（ミリ秒）。デフォルトは 30 秒。 */
  timeoutMs?: number;
  log?: (line: string) => void;
};

/**
 * 最初の端末トークンで、この PC を Worker に登録する（POST /bootstrap）。
 * setup の直後は、secret put で入れた BOOTSTRAP_TOKEN_HASH がまだ反映されていない isolate が 401 を返すことがあるので、503 と 401 は待って再試行する。
 * トークンは本文に載せる。URL にも argv にも載せない。
 */
export async function bootstrapDevice(url: string, token: string, deviceId: string, o: BootstrapOptions): Promise<void> {
  const retries = o.retries ?? BOOTSTRAP_RETRIES;
  for (let i = 0; ; i++) {
    const r = await workerFetch(url, '/bootstrap', { fetch: o.fetch, method: 'POST', body: { deviceId, token }, timeoutMs: o.timeoutMs });
    if (r.status === 201) return;
    const waitable = r.status === 503 || r.status === 401;
    if (waitable && i < retries) {
      o.log?.('Worker への反映を待っています');
      await o.sleep(HEALTH_INTERVAL_MS);
      continue;
    }
    // 応答の本文は出さない。
    if (r.status === 401) throw new JoinError('forbidden', `この PC を Worker に登録できませんでした（HTTP 401）。同じ名前の Worker の D1 に、この PC がすでに登録されている可能性があります。Cloudflare にある古いリソースを削除してから、hangar setup cloud をもう一度実行してください`);
    throw new JoinError('failed', `この PC を Worker に登録できませんでした（HTTP ${r.status}）`);
  }
}

/**
 * 実物の資源を指す wrangler の設定を ~/.agent-hangar/cloud/wrangler.jsonc に書く。
 * アカウント ID はここに書かず、実行のたびに環境変数で渡す。
 */
export function writeWranglerConfig(home: string, o: { name: string; main: string; dbName: string; dbId: string; bucketName: string; assetsDir: string }): string {
  const dir = cloudDirIn(home);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = wranglerConfigPath(home);
  const cfg = {
    name: o.name,
    main: o.main,
    compatibility_date: '2026-08-01',
    compatibility_flags: ['nodejs_compat'],
    d1_databases: [{ binding: 'DB', database_name: o.dbName, database_id: o.dbId }],
    r2_buckets: [{ binding: 'BUCKET', bucket_name: o.bucketName }],
    // スマホの画面（/app/ 以下）は静的ファイルとして Worker より先に返る。run_worker_first は置かない。
    assets: { directory: o.assetsDir },
    // 呼び鈴（Durable Object の HangarBell）。PC が WebSocket でつなぎ、スマホの起動と問い合わせを渡す。
    // 無料プランで使えるのは SQLite 型だけなので、new_sqlite_classes で足す。packages/cloud/wrangler.jsonc と同じにする。
    durable_objects: { bindings: [{ name: 'BELL', class_name: 'HangarBell' }] },
    migrations: [{ tag: 'bell-v1', new_sqlite_classes: ['HangarBell'] }],
    vars: {},
  };
  const head = [
    '// hangar setup cloud が生成したファイル。手動で書き換えても次の実行で上書きされる。',
    '// アカウント ID は環境変数で渡すため、ここには書かない。',
    '// BOOTSTRAP_TOKEN_HASH は wrangler secret で設定するため、ここには書かない。',
    '',
  ].join('\n');
  fs.writeFileSync(file, head + JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
  return file;
}

/** スマホの画面の置き場（packages/mobile）。cloudDir（packages/cloud）の隣である。 */
export function mobileDirOf(cloudDir: string): string {
  return path.resolve(cloudDir, '..', 'mobile');
}

/**
 * スマホの画面を建てる。出力は <mobileDir>/dist/app で、配信の根は <mobileDir>/dist（_headers もそこに置かれる）。
 * npm や npx を通さず、node で vite を直に走らせる。シェルも PATH も要らないので、Windows でも同じに動く。
 */
export async function buildMobileApp(mobileDir: string, o: { exec?: Exec; resolveVite?: (mobileDir: string) => string } = {}): Promise<void> {
  const vite = (o.resolveVite ?? resolveViteBin)(mobileDir);
  const r = await (o.exec ?? defaultExec)(process.execPath, [vite, 'build'], { cwd: mobileDir, env: process.env });
  if (r.code !== 0) {
    const tail = `${r.stdout}\n${r.stderr}`.trim().split('\n').slice(-12).join('\n');
    throw new DetailedError(`スマホの画面のビルドに失敗しました（vite build、終了コード ${r.code}）。\n${tail}`);
  }
}

function resolveViteBin(mobileDir: string): string {
  const pkgPath = createRequire(path.join(mobileDir, 'package.json')).resolve('vite/package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { bin?: string | Record<string, string> };
  const rel = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.vite;
  if (!rel) throw new Error(`${pkgPath} に vite の実行ファイルがありません`);
  return path.resolve(path.dirname(pkgPath), rel);
}

/**
 * いまの cloud.json が別の Worker を指しているときの警告と確認。
 * teardown は cloud.json に書いてある名前しか見ないので、黙って書き換えると前の資源に手が届かなくなる。
 * hangar-dev で試してから本番を作る段取り（決定 7 と決定 9）で、まさにここを通る。
 */
async function confirmRename(log: (l: string) => void, prev: CloudConfig, name: string, confirm: ConfirmWord): Promise<void> {
  log('');
  if (prev.workerName) {
    log(`警告: この PC はすでに Worker ${prev.workerName} を作成しています。`);
    log('');
    log(`  現在のリソース: Worker ${prev.workerName}、D1 ${prev.dbName ?? '?'}、R2 ${prev.bucketName ?? '?'}（${prev.url}）`);
    log(`  これから作成するリソース: Worker ${name}、D1 ${name}、R2 ${name}-files`);
    log('');
    log(`${name} で作成し直すと、cloud.json の接続先が新しい方へ移ります。`);
    log(`teardown は cloud.json に書いてある名前しか見ないため、前のリソース（Worker ${prev.workerName}、D1 ${prev.dbName ?? '?'}、R2 ${prev.bucketName ?? '?'}）は、この PC からは削除できなくなります。`);
    log('Cloudflare のダッシュボードで削除する必要があり、削除するまで無料枠を消費し続けます。');
    log(`先に削除する場合は、ここで中止して hangar cloud teardown を実行してください（現在の cloud.json は ${prev.workerName} を指しています）。`);
  } else {
    log('警告: この PC は他の PC が作成したクラウドに参加しています。');
    log('');
    log(`  現在の接続先: ${prev.url}`);
    log(`  これから作成するリソース: Worker ${name}、D1 ${name}、R2 ${name}-files`);
    log('');
    log('自分の Worker を作成すると、cloud.json の接続先がそちらへ移り、現在のクラウドとの同期は停止します。');
    log('この PC の暗号鍵も新しく作成するため、現在のクラウドのデータはこの PC から読み取れなくなります（すでにダウンロードしたトランスクリプトはそのまま読み取れます）。');
  }
  if (!(await confirm('本当に新しいリソースを作成して cloud.json を移しますか？', RENAME_WORD))) throw new Error('cloud.json の切り替えをキャンセルしました');
}

/** 他の PC を追加する手順の案内。 */
function printNextSteps(log: (l: string) => void, url: string): void {
  log('');
  log('hangar を再起動すると同期が始まります。');
  log('他の PC を追加するには、この PC の hangar の 設定 › クラウド同期 で「PC を追加」をクリックして参加コードを発行し、');
  log(`追加する PC で hangar cloud join ${url} を実行して参加コードを入力します。`);
}

/**
 * 名簿と keybox が無ければ作る（setup の最初の 1 回と、途中で止まった setup のやり直し）。
 * 名簿にはこの PC とリカバリーキーの公開鍵を入れ、keybox はこの PC と recovery に、世代鍵の一覧をそれぞれ封じて置く。
 * keybox を先に置き、名簿を後に置く。名簿が置けた時点で作成は完了で、次の setup は何もしない。
 * リカバリーキーは、どちらを置くよりも先に表示し、保存を確かめる（confirm）。
 * 確かめられなければ confirm が投げ、名簿も keybox も置かずに止まる。次の setup は新しいリカバリーキーから続ける。
 * 作ったときはリカバリーキーの 4 行の文字列と名簿の版を返し、名簿がすでにあればキーを null にして今の名簿の版を返す。
 * cloud.json は書かない。書くのは呼び手で、名簿と recovery の keybox を置けた後に版 2 を書く（それまでは下書き）。
 */
async function ensureRoster(o: { conf: CloudConfig; device: DeviceLike; fetch: typeof fetch; now: number; confirm: (text: string) => Promise<void> }): Promise<{ recoveryKey: string | null; rosterVersion: number }> {
  const { conf } = o;
  const client = new HttpCloudClient({ url: conf.url, token: conf.deviceToken, fetch: o.fetch });
  const existing = await client.getRoster();
  if (existing) return { recoveryKey: null, rosterVersion: existing.version };
  const epoch = conf.currentEpoch;
  const epochKey = conf.epochs[String(epoch)];
  if (!epochKey) throw new Error('cloud.json に現在の世代の暗号鍵がありません');
  const recovery = await generateKeyPair();
  const text = formatRecoveryKey({ priv: recovery.priv, url: conf.url, createdAt: o.now });
  await o.confirm(text);
  // ここから先で止まると、いま保存してもらったリカバリーキーはクラウドに登録されない。次の setup は新しいキーを作る。
  let r: { ok: boolean; version: number };
  try {
    const list = encodeEpochList({ epochs: conf.epochs });
    const boxes: KeyboxIn[] = [
      { epoch, recipient: o.device.id, sealed: toBase64Url(await sealKeybox(conf.keyPair.pub, { epoch, recipient: o.device.id }, list)) },
      { epoch, recipient: RECOVERY_RECIPIENT, sealed: toBase64Url(await sealKeybox(recovery.pub, { epoch, recipient: RECOVERY_RECIPIENT }, list)) },
    ];
    const put = await workerFetch(conf.url, '/keyboxes', { fetch: o.fetch, method: 'PUT', body: { boxes }, token: conf.deviceToken });
    if (!put.ok) throw new Error(`暗号鍵を Worker に保存できませんでした（HTTP ${put.status}）。hangar setup cloud をもう一度実行してください`);
    const roster: Roster = {
      v: 1,
      entries: [{ id: o.device.id, kind: 'pc', name: o.device.name, os: o.device.platform, pub: conf.keyPair.pub, joinedAt: conf.joinedAt }],
      recoveryPub: recovery.pub,
      phoneKey: conf.phoneKey,
    };
    const keys = await deriveEpochKeys(epoch, epochKey);
    r = await client.putRoster({ ifVersion: 0, epoch, sealed: toBase64Url(await sealRoster(keys.roster, 1, roster)) });
    if (!r.ok) throw new Error('PC の一覧を作成できませんでした（Worker にすでに一覧があります）。Cloudflare にある古いリソースを削除してから、hangar setup cloud をもう一度実行してください');
  } catch (e) {
    const base = (e instanceof Error ? e.message : String(e)).trimEnd();
    throw new Error(`${/[。.]$/.test(base) ? base : `${base}。`}${UNREGISTERED_RECOVERY_KEY}`, { cause: e });
  }
  return { recoveryKey: text, rosterVersion: r.version };
}

/** 確認の後で名簿か keybox を置けずに止まったときに足す文。 */
const UNREGISTERED_RECOVERY_KEY = '先に保存したキーは使えません。もう一度実行して、新しいキーを保存してください';

/**
 * setup cloud の下書き（~/.agent-hangar/cloud-setup-pending.json、0600）。
 * 最初の端末トークンは、同じ端末 ID では 2 度と登録できない。
 * そのため、登録（bootstrap）が通ったら、端末トークンと暗号鍵を含む版 2 の設定をここに書く。
 * cloud.json の版 2 は、名簿と recovery の keybox を置けた後に初めて書く。
 * cloud.json の版 2 が現れるとアプリが同期を始める（boot/sync.ts の watchForCloud）ので、名簿もリカバリーキーも無いクラウドで同期を始めさせないためである。
 * 確認の段で止まっても、もう一度の setup はこの下書きから続ける（同じ Worker、同じ端末トークンと暗号鍵）。
 * 形は recover の下書き（cloud-recover-pending.json）と同じく、書き換えは一時ファイルからの rename で行う。
 */
type PendingSetup = { v: 1; deviceId: string; conf: CloudConfig; createdAt: number };

export function setupPendingPath(home: string): string {
  return path.join(home, 'cloud-setup-pending.json');
}

function writeSetupPending(home: string, p: PendingSetup): void {
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const file = setupPendingPath(home);
  const tmp = `${file}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`;
  let fd: number | null = null;
  try {
    fd = fs.openSync(tmp, 'wx', 0o600);
    fs.writeFileSync(fd, JSON.stringify(p, null, 2) + '\n');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tmp, file);
  } catch (e) {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* 閉じられないなら諦める */ } }
    try { fs.rmSync(tmp, { force: true }); } catch { /* 元のファイルは無事である */ }
    throw e;
  }
}

/** 下書きを読む。無いか形が違えば null（形の違う下書きからは続けない）。 */
function readSetupPending(home: string): PendingSetup | null {
  try {
    const v = JSON.parse(fs.readFileSync(setupPendingPath(home), 'utf8')) as Partial<PendingSetup>;
    if (v.v !== 1 || typeof v.deviceId !== 'string' || typeof v.conf !== 'object' || v.conf === null) return null;
    const conf = parseCloudConfigV2(v.conf as unknown as Record<string, unknown>);
    if (!conf || !conf.workerName) return null;
    return { v: 1, deviceId: v.deviceId, conf, createdAt: typeof v.createdAt === 'number' ? v.createdAt : 0 };
  } catch {
    return null;
  }
}

/**
 * 床を刻むための DB を先に開く。
 * 開けなかった（控えが取れずに止まった）ときは、元の文の後ろに、外に何も作っていないことと次にすることを足して投げ直す。
 * 文は 1 行で出る（oneLineError）ので、改行は入れない。
 * setup と参加（membership.ts の join-request と join-poll）が使う。
 */
export function openFloorFirst(home: string, nothingMade: string, retry: string): ReturnType<typeof openTranscriptsFloor> {
  try {
    return openTranscriptsFloor(home);
  } catch (e) {
    const base = (e instanceof Error ? e.message : String(e)).trimEnd();
    const head = /[。.]$/.test(base) ? base : `${base}。`;
    throw new Error(`${head}${nothingMade}。修正してから ${retry} をもう一度実行してください。`, { cause: e });
  }
}

/**
 * いまのログインで使える Cloudflare のアカウントを全部読む。
 * `wrangler whoami --json` を先に使い、JSON が返らなければ（--json を知らない版）表を読む。
 * whoami は CLOUDFLARE_ACCOUNT_ID が立っていても全アカウントを並べる。
 */
export async function readAccounts(wr: WranglerRunner): Promise<WhoamiResult> {
  const j = await wr.run(['whoami', '--json']);
  const fromJson = parseWhoamiJson(j.stdout);
  if (fromJson) return fromJson;
  const t = await wr.run(['whoami']);
  return t.code === 0 ? parseWhoamiTable(t.stdout + t.stderr) : { loggedIn: false, accounts: [] };
}

const accountLabel = (a: CfAccount): string => `${a.name || '（名前なし）'}（${a.id}）`;

/** 他人も入るアカウントを選ぶと何が起きるか。一覧を見せるときに添える。 */
const SHARED_ACCOUNT_NOTE = '他の人も参加しているアカウントに作成すると、その人たちも同期のメタデータ（平文）を読み取れます。自分だけが使うアカウントを選択してください。';

/**
 * 端末で、番号を打ってアカウントを選ばせる。
 * 空（EOF も）は選ばなかった扱いにする。範囲の外は聞き直し、3 回で諦める。
 */
export async function chooseAccountByNumber(accounts: CfAccount[], ask: (question: string) => Promise<string>, log: (l: string) => void): Promise<CfAccount | null> {
  log('');
  log('このログインでは Cloudflare のアカウントが複数あります。同期のリソース（Worker、D1、R2）を作成するアカウントを選択してください。');
  log(SHARED_ACCOUNT_NOTE);
  log('');
  accounts.forEach((a, i) => log(`  ${i + 1}. ${accountLabel(a)}`));
  log('');
  for (let tries = 0; tries < 3; tries++) {
    const a = (await ask(`番号を入力してください（1-${accounts.length}、空で中止）: `)).trim();
    if (a === '') return null;
    const n = Number(a);
    if (Number.isInteger(n) && n >= 1 && n <= accounts.length) return accounts[n - 1]!;
    log(`1 から ${accounts.length} の番号を入力してください。`);
  }
  return null;
}

/**
 * 作る先のアカウントを決める。
 * 指定（--account-id、無ければ CLOUDFLARE_ACCOUNT_ID）があればそれを使い、ログインの一覧に無ければ止める。
 * 指定が無ければ、cloud.json に前回のアカウントがあって一覧にあればそれを、1 つだけならそれを使う。
 * 複数なら、端末では一覧から選ばせ、対話できなければ止めて --account-id を案内する。
 * どの道でも、ここで止まるときは Cloudflare にまだ何も作っていない。
 */
async function pickAccount(o: {
  accounts: CfAccount[];
  requested: { id: string; from: string } | null;
  prevId: string | null;
  interactive: boolean;
  choose: ChooseAccount;
  log: (l: string) => void;
}): Promise<CfAccount> {
  const list = o.accounts.map((a) => `  ${accountLabel(a)}`);
  if (o.requested) {
    const { id, from } = o.requested;
    const hit = isAccountId(id) ? o.accounts.find((a) => a.id === id.toLowerCase()) : undefined;
    if (hit) return hit;
    const why = isAccountId(id) ? `${from} のアカウント（${id}）は、現在のログインで使えるアカウントにありません。` : `${from} の値（${id}）はアカウント ID の形式（32 桁の 16 進）ではありません。`;
    throw new DetailedError([why, '現在のログインで使えるアカウント:', ...list, `${from} を修正してから、もう一度実行してください。Cloudflare にはまだ何も作成していません。`].join('\n'));
  }
  const prev = o.prevId ? o.accounts.find((a) => a.id === o.prevId!.toLowerCase()) : undefined;
  if (prev) {
    o.log(`cloud.json と同じアカウントを使います: ${accountLabel(prev)}`);
    return prev;
  }
  if (o.accounts.length === 1) return o.accounts[0]!;
  if (!o.interactive) {
    throw new DetailedError(
      [
        `このログインでは Cloudflare のアカウントが ${o.accounts.length} 個あり、標準入力がターミナルではないため、作成先を選択できません。`,
        ...list,
        '--account-id <ID> か環境変数 CLOUDFLARE_ACCOUNT_ID で作成先を指定して、もう一度実行してください。',
        SHARED_ACCOUNT_NOTE,
        'Cloudflare にはまだ何も作成していません。',
      ].join('\n'),
    );
  }
  const chosen = await o.choose(o.accounts);
  if (!chosen) throw new Error('アカウントの選択をキャンセルしました。Cloudflare にはまだ何も作成していません');
  return chosen;
}

/**
 * 前回と違うアカウントに作るときの警告と確認。
 * teardown は cloud.json のアカウントしか見ないので、前のアカウントの資源はこの端末から片付けられなくなる。
 */
async function confirmAccountChange(log: (l: string) => void, prev: CloudConfig, next: CfAccount, confirm: ConfirmWord): Promise<void> {
  log('');
  log(`警告: この PC は別のアカウント（${prev.accountId}）に Worker ${prev.workerName} を作成しています。`);
  log(`作成先のアカウント: ${accountLabel(next)}`);
  log(`作成し直すと、cloud.json の接続先が新しいアカウントへ移ります。teardown は cloud.json に書いてあるアカウントしか見ないため、前のアカウントのリソース（Worker ${prev.workerName}、D1 ${prev.dbName ?? '?'}、R2 ${prev.bucketName ?? '?'}）は、この PC からは削除できなくなります。`);
  log('先に削除する場合は、ここで中止して hangar cloud teardown を実行してください。');
  if (!(await confirm('本当に別のアカウントに作成して cloud.json を移しますか？', RENAME_WORD))) throw new Error('別のアカウントへの切り替えをキャンセルしました');
}

export type SetupCloudResult = {
  url: string;
  /** 新しく作ったリカバリーキーの 4 行。Worker に名簿がすでにあって作らなかったとき（Worker の入れ替え）は null。 */
  recoveryKey: string | null;
};

/**
 * ユーザーの Cloudflare アカウントに Worker と D1 と R2 を作成してデプロイし、この PC を最初の PC として登録する。
 * 最初の 1 回は、この PC の鍵ペア、世代 1 の世代鍵、リカバリーキーを作り、名簿と keybox を Worker に置き、リカバリーキーを表示する。
 * 同じ名前で 2 回目以降に実行したとき（Worker の入れ替え）は、既存のリソースと cloud.json の暗号鍵をそのまま使い、デプロイだけをやり直す。
 */
export async function runSetupCloud(o: SetupCloudOptions): Promise<SetupCloudResult> {
  const log = o.log ?? ((l: string) => console.log(l));
  const fetchFn = o.fetch ?? realFetch;
  const sleep = o.sleep ?? realSleep;
  const cloudDir = o.cloudDir ?? requireCloudDir();
  const name = o.name ?? 'hangar';
  const dbName = name;
  const bucketName = `${name}-files`;
  let wr = o.wrangler ?? new WranglerRunner({ cloudDir, accountId: null, log });

  // 0. 今の cloud.json を先に読む。
  // 壊れた cloud.json を「未参加」と読み替えて作り直すと、この PC の暗号鍵を失う。
  // 古い形式の cloud.json は teardown だけが読むので、上書きせずに止める（版 1 を版 2 で上書きしない）。
  const read = readCloudConfig(o.home);
  if (read.state === 'broken') throw new Error(brokenConfigMessage(o.home));
  if (read.state === 'legacy') throw new DetailedError(legacyConfigMessage(o.home));
  const prev = read.config;
  // 名前が変わる（または参加だけの PC が自分の Worker を作る）ときは、前のリソースが置き去りになる。
  // リソースを 1 つも作る前に、何にアクセスできなくなるかを見せて確認する。
  if (prev && prev.workerName !== name) await confirmRename(log, prev, name, o.confirm ?? promptWord);
  // 同じ名前の Worker を作ったのがこの PC なら、Worker の入れ替えである。暗号鍵も端末トークンも作り直さない。
  const redeploy = prev !== null && prev.workerName === name;
  // 前の setup が登録の後、名簿を置く前に止まっていれば、その下書きから続ける（同じ端末 ID は 2 度登録できない）。
  // 名前か端末が違う下書きは使わない。新しく作るときに上書きする。
  const draft = redeploy ? null : readSetupPending(o.home);
  let resume = draft && draft.deviceId === o.device.id && draft.conf.workerName === name ? draft.conf : null;

  // スマホの画面を建てる。配備は Worker と一緒にこの dist を上げるので、資源を作る前に済ませる。
  // 源が無い（clone していない）か、建てても index.html が出なければ、Cloudflare にはまだ何も作らずに止まる。
  const mobileDir = mobileDirOf(cloudDir);
  if (!fs.existsSync(path.join(mobileDir, 'package.json'))) {
    throw new DetailedError(`スマホの画面のソース（packages/mobile）が ${mobileDir} にありません。クラウド同期の設定は、リポジトリを clone して npm install したディレクトリから実行してください。Cloudflare にはまだ何も作成していません`);
  }
  log('スマホの画面をビルドします');
  await (o.buildMobile ?? ((d) => buildMobileApp(d)))(mobileDir);
  const assetsDir = path.join(mobileDir, 'dist');
  if (!fs.existsSync(path.join(assetsDir, 'app', 'index.html'))) {
    throw new DetailedError(`スマホの画面をビルドしましたが ${path.join(assetsDir, 'app', 'index.html')} がありません。空の画面をデプロイしないよう、ここで停止します。Cloudflare にはまだ何も作成していません`);
  }

  // DB を先に開く。
  // マイグレーションの前の控え（db/backup.ts）が取れなければ、ここで投げて止まる。
  // Cloudflare にはまだ何も作っていないので、直してからもう一度実行すればよい。
  // 後ろで開くと、Worker を配備して登録し cloud.json を書いた後で止まる。
  const floor = openFloorFirst(o.home, 'Cloudflare にはまだ何も作成していません', 'hangar setup cloud');
  try {
    // 1. アカウント
    // 一覧の 1 つ目で決めない。アカウントが複数ある人の作り先が並び順で決まり、他人も入るアカウントに作ってしまう。
    let who = await readAccounts(wr);
    if (!who.loggedIn) {
      log('Cloudflare にログインします。ブラウザが開きます。');
      const code = await wr.runInteractive(['login']);
      if (code !== 0) throw new Error('wrangler login に失敗しました');
      who = await readAccounts(wr);
      if (!who.loggedIn) throw new Error('アカウントを読み取れませんでした。wrangler whoami の出力を確認してください');
    }
    if (who.accounts.length === 0) throw new Error('このログインで使える Cloudflare のアカウントがありません。wrangler whoami の出力を確認してください。Cloudflare にはまだ何も作成していません');
    const envAccount = (o.env ?? process.env).CLOUDFLARE_ACCOUNT_ID?.trim();
    const requested = o.accountId !== undefined ? { id: o.accountId.trim(), from: '--account-id' } : envAccount ? { id: envAccount, from: 'CLOUDFLARE_ACCOUNT_ID' } : null;
    const interactive = o.interactive ?? process.stdin.isTTY === true;
    const account = await pickAccount({
      accounts: who.accounts,
      requested,
      prevId: resume?.accountId ?? (prev?.workerName ? prev.accountId : null),
      interactive,
      choose: o.chooseAccount ?? ((list) => chooseAccountByNumber(list, askLine, log)),
      log,
    });
    if (prev?.workerName && prev.accountId && prev.accountId.toLowerCase() !== account.id) await confirmAccountChange(log, prev, account, o.confirm ?? promptWord);
    // 下書きの Worker は別のアカウントにある。その端末トークンは、これから作る Worker では使えない。
    if (resume && resume.accountId?.toLowerCase() !== account.id) {
      log('途中で止まった前回の setup とは別のアカウントのため、最初から作成します。');
      resume = null;
    }
    const accountId = account.id;
    log(`作成先の Cloudflare アカウント: ${accountLabel(account)}`);
    wr = wr.withAccount(accountId);

    // 2. R2 の確認と、D1 と R2
    // R2 が有効でないアカウントは、D1 を作ったあとで R2 の作成が落ちて、作りかけが残る。作る前に、一覧が通るかで確かめる。
    // 10042 だけを断る。ほかの失敗はここでは決めつけず、あとの手順がそれぞれの理由を出す。
    const r2 = await wr.run(['r2', 'bucket', 'list']);
    if (r2.code !== 0 && /\[code: 10042\]/.test(`${r2.stderr}\n${r2.stdout}`)) throw wranglerFailure('R2 の確認', r2, R2_OFF_HINT);
    const info = await wr.run(['d1', 'info', dbName, '--json']);
    let dbId = info.code === 0 ? parseDatabaseId(info.stdout) : null;
    if (!dbId) {
      const created = await wr.run(['d1', 'create', dbName]);
      dbId = parseDatabaseId(created.stdout + created.stderr);
      if (created.code !== 0 || !dbId) throw wranglerFailure('D1 の作成', created);
      log(`D1 ${dbName} を作成しました`);
    } else {
      log(`D1 ${dbName} はすでにあります`);
    }
    const bucket = await wr.run(['r2', 'bucket', 'create', bucketName]);
    if (bucket.code !== 0 && !/already exists/i.test(bucket.stderr + bucket.stdout)) throw wranglerFailure('R2 の作成', bucket);
    log(bucket.code === 0 ? `R2 ${bucketName} を作成しました` : `R2 ${bucketName} はすでにあります`);

    // 3. 設定と 4. デプロイ
    const cfg = writeWranglerConfig(o.home, { name, main: path.join(cloudDir, 'src', 'index.ts'), dbName, dbId, bucketName, assetsDir });
    const dep = await wr.run(['deploy', '--config', cfg]);
    const url = parseWorkerUrl(dep.stdout + dep.stderr);
    if (dep.code !== 0 || !url) throw wranglerFailure('デプロイ', dep);
    log(`デプロイしました: ${url}`);

    // 5. 最初の端末トークンのハッシュを Worker の secret へ。平文は argv に載せず、ハッシュを標準入力から渡す。
    // Worker の入れ替えでは入れない。この PC はもう登録済みで、端末トークンは cloud.json にある。
    // 下書きから続けるときも入れない。端末トークンは下書きにあり、Worker に登録済みである。
    const token = redeploy || resume ? null : randomBytes(32).toString('base64url');
    if (token) {
      const put = await wr.run(['secret', 'put', 'BOOTSTRAP_TOKEN_HASH', '--config', cfg], sha256Hex(token) + '\n');
      if (put.code !== 0) throw wranglerFailure('secret の登録', put);
    }

    // 6. health
    log('Worker の反映を待っています（最大 2 分）');
    const health = await waitForHealthBody(url, { fetch: fetchFn, sleep });
    if (!health) {
      throw new Error(`${url}/health から 2 分以内に正常な応答がありませんでした。しばらく待ってから hangar setup cloud をもう一度実行してください`);
    }

    // 7. 登録と下書き
    let conf: CloudConfig;
    if (prev && redeploy) {
      conf = { ...prev, url, accountId, dbName, bucketName };
      if (prev.url !== url || prev.accountId !== accountId || prev.dbName !== dbName || prev.bucketName !== bucketName) saveCloudConfig(o.home, conf);
    } else if (resume) {
      if (health.cloudId !== resume.cloudId) {
        throw new DetailedError(`${url} のクラウドの ID が、途中で止まった前回の setup のものと違います（D1 を再作成した可能性があります）。前回の setup で登録したこの PC 用のトークンは使えないため、${setupPendingPath(o.home)} を削除してから、hangar setup cloud をもう一度実行してください`);
      }
      log('途中で止まった前回の setup の続きから再開します。');
      conf = { ...resume, url, accountId, dbName, bucketName };
      writeSetupPending(o.home, { v: 1, deviceId: o.device.id, conf, createdAt: Date.now() });
    } else {
      if (typeof health.cloudId !== 'string' || health.cloudId === '') throw new Error(`${url}/health が cloudId を返しません。Worker のソースが古い可能性があります。リポジトリを最新にしてから、hangar setup cloud をもう一度実行してください`);
      const keyPair = await generateKeyPair();
      await bootstrapDevice(url, token!, o.device.id, { fetch: fetchFn, sleep, log });
      // 登録できたら、端末トークンを失わないよう、名簿を置く前に下書きへ書く。
      // cloud.json の版 2 はまだ書かない（書くとアプリが名簿の無いクラウドで同期を始める）。
      // 名簿を置く前に止まっても、もう一度 setup を実行すれば下書きから続きを作る（ensureRoster）。
      conf = {
        v: 2,
        url,
        cloudId: health.cloudId,
        deviceToken: token!,
        keyPair,
        epochs: { '1': randomEpochKey() },
        currentEpoch: 1,
        phoneKey: null,
        rosterVersion: 0,
        workerName: name,
        accountId,
        dbName,
        bucketName,
        joinedAt: Date.now(),
      };
      writeSetupPending(o.home, { v: 1, deviceId: o.device.id, conf, createdAt: conf.joinedAt });
    }

    // 8. リカバリーキーの表示と保存の確認、名簿と keybox、cloud.json
    // 保存を確かめる前に名簿を置くと、確かめられずに止まった setup のやり直しで名簿があるため、リカバリーキーを 2 度と表示できない。
    const confirm = (text: string): Promise<void> =>
      showAndConfirmRecoveryKey({
        text,
        ask: o.recoveryAsk ?? askLine,
        write: o.recoveryWrite ?? ((s) => { process.stdout.write(s); }),
        ...(o.saveRecoveryTo ? { saveTo: o.saveRecoveryTo } : {}),
        askSavePath: o.recoveryAsk === undefined && process.stdin.isTTY === true,
      });
    const { recoveryKey, rosterVersion } = await ensureRoster({ conf, device: o.device, fetch: fetchFn, now: Date.now(), confirm });
    // 名簿と recovery の keybox を置けたので、cloud.json の版 2 を書く。ここで初めてアプリが同期を始める。
    // Worker の入れ替えで名簿がすでにあったときは、cloud.json の名簿の版はアプリが持っているので書き換えない。
    if (!redeploy || recoveryKey) saveCloudConfig(o.home, { ...conf, rosterVersion });
    if (!redeploy) {
      // 本文をどこから上げるかの床を、cloud.json を書くのと同じ時点で刻む。
      // サーバーの起動を待つと、床を刻まない古いサーバーが先に走ったときに床の無い隙が生まれる。
      floor.stamp(conf.joinedAt);
      fs.rmSync(setupPendingPath(o.home), { force: true });
    }
    if (!recoveryKey) {
      log(redeploy ? 'Worker を入れ替えました。この PC の暗号鍵とリカバリーキーは変わりません。' : '途中で止まった前回の setup を完了しました。リカバリーキーは、前回保存したものを使います。');
    }
    printNextSteps(log, url);
    // 使用量のトークンは任意。端末から打たれたときだけ尋ね、飛ばしても setup はここで終わる。
    if (process.stdin.isTTY && !o.skipUsageToken) {
      log('');
      for (const l of USAGE_TOKEN_HELP) log(l);
      if ((await askLine('使用量のトークンを追加しますか（後からでも追加できます） [y/N]: ')).trim().toLowerCase() === 'y') {
        await offerUsageToken(async () => installUsageToken({ home: o.home, token: await readUsageToken(), fetch: fetchFn, wrangler: wr, log, cloudDir }), log);
      }
    }
    return { url, recoveryKey };
  } finally {
    floor.close();
  }
}

// ---- 使用量のトークン ----

/**
 * setup の続きで使用量のトークンを入れる。任意の手順なので、失敗しても済んだ setup を落とさない。
 * 理由を言い、入れ直し方を添えて戻る。理由の文は installUsageToken が組み立てたもので、トークンを含まない。
 */
export async function offerUsageToken(install: () => Promise<void>, log: (l: string) => void): Promise<void> {
  try {
    await install();
  } catch (e) {
    log(e instanceof Error ? e.message : String(e));
    log('あとから、リポジトリを clone して npm install したディレクトリで npm run hangar -- setup cloud --usage-token を実行すると追加し直せます');
  }
}

/** 作るトークンの案内。setup の問いと --usage-token の前に出す。 */
export const USAGE_TOKEN_HELP = [
  '使用量と料金を設定画面に表示するには、読み取り専用の API トークンを Worker に追加します（無くても同期は動作します）。',
  '作成方法:',
  '  1. Cloudflare のダッシュボードを開き、Manage account → Account API tokens → Create Token → Start from scratch と進みます。',
  '  2. 権限を 2 つ追加します。Account Analytics: Read と Billing: Read です（範囲は Entire Account）。',
  '  3. 作成したトークンは、その画面でしか表示されません。コピーしてから、リポジトリを clone したディレクトリで npm run hangar -- setup cloud --usage-token を実行し、求められたら貼り付けます（画面には表示されません）。',
  '  1Password を使っている人は、op read "op://…" | npm run hangar -- setup cloud --usage-token を実行すると、貼り付けずに渡せます。',
];

const CF_API = 'https://api.cloudflare.com/client/v4';

/** 標準入力からトークンを読む。端末なら伏せ字で尋ね、パイプなら全部を読む。argv には載せない。 */
export async function readUsageToken(): Promise<string> {
  if (!process.stdin.isTTY) {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of process.stdin) {
      size += (c as Buffer).length;
      if (size > MAX_STDIN_BYTES) throw new Error('標準入力が長すぎます。トークンだけを渡してください');
      chunks.push(c as Buffer);
    }
    return Buffer.concat(chunks).toString('utf8');
  }
  holdStdin(true);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  // 打った文字を画面に出さない。問いの文だけは書く。
  const prompt = '使用量のトークンを貼り付けてください（表示しません）: ';
  (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = (s: string) => { if (s.includes(prompt)) process.stdout.write(prompt); };
  return new Promise<string>((resolve) => {
    let done = false;
    const finish = (a: string): void => { if (done) return; done = true; rl.close(); holdStdin(false); process.stdout.write('\n'); resolve(a); };
    rl.on('close', () => finish(''));
    rl.question(prompt, finish);
  });
}

/**
 * トークンを確かめてから Worker の secret に入れる。
 * 確かめるのは、有効か（tokens/verify）と、二つの権限があるか（subscriptions と GraphQL を 1 回ずつ）。
 */
export async function installUsageToken(o: { home: string; token: string; fetch?: typeof fetch; wrangler?: WranglerRunner; log?: (l: string) => void; cloudDir?: string }): Promise<void> {
  const log = o.log ?? ((l: string) => console.log(l));
  const fetchFn = o.fetch ?? realFetch;
  const token = o.token.trim();
  if (!token) throw new Error('トークンが空です');
  const read = readCloudConfig(o.home);
  if (read.state === 'broken') throw new Error(brokenConfigMessage(o.home));
  if (read.state === 'legacy') throw new DetailedError(legacyConfigMessage(o.home));
  const conf = read.config;
  if (!conf || !conf.accountId || !conf.workerName) throw new Error('トークンは、hangar setup cloud を実行した PC で追加してください（この PC は参加しただけのため、Worker の設定を持っていません）');
  const accountId = conf.accountId;
  const headers = { authorization: `Bearer ${token}` };
  const status = async (p: string, init: RequestInit = {}): Promise<number> => {
    try { return (await fetchFn(`${CF_API}${p}`, { ...init, headers: { ...headers, ...(init.headers as Record<string, string> | undefined) } })).status; } catch { return 0; }
  };
  if ((await status(`/accounts/${accountId}/tokens/verify`)) !== 200) throw new Error('トークンが有効ではありません。値と、アカウントのトークンであることを確認してください');
  if ((await status(`/accounts/${accountId}/subscriptions`)) !== 200) throw new Error('権限が足りません: Billing: Read を追加してください');
  // GraphQL は権限の誤りを 200 と errors で返すことが多いので、Worker が引くのと同じ表を実際に引いて中身まで見る。
  const analyticsOk = async (): Promise<boolean> => {
    const day = new Date().toISOString().slice(0, 10);
    const query = 'query($a:String!,$d:Date!){viewer{accounts(filter:{accountTag:$a}){d1AnalyticsAdaptiveGroups(limit:1,filter:{date_geq:$d,date_leq:$d}){sum{rowsWritten}}}}}';
    try {
      const res = await fetchFn(`${CF_API}/graphql`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ query, variables: { a: accountId, d: day } }) });
      if (res.status !== 200) return false;
      const body = (await res.json()) as { errors?: unknown[] | null; data?: { viewer?: { accounts?: { d1AnalyticsAdaptiveGroups?: unknown }[] } } | null };
      if (Array.isArray(body.errors) && body.errors.length > 0) return false;
      return Array.isArray(body.data?.viewer?.accounts?.[0]?.d1AnalyticsAdaptiveGroups);
    } catch { return false; }
  };
  if (!(await analyticsOk())) throw new Error('権限が足りません: Account Analytics: Read を追加してください');
  // wrangler を渡されたとき（試験と setup の続き）は、Worker の元の場所を探さない。
  const wr = (o.wrangler ?? new WranglerRunner({ cloudDir: o.cloudDir ?? requireCloudDir(), accountId: null, log })).withAccount(accountId);
  const cfg = wranglerConfigPath(o.home);
  for (const [name, value] of [['USAGE_API_TOKEN', token], ['CF_ACCOUNT_ID', accountId]] as const) {
    // 平文は標準入力から渡し、argv には載せない。
    const put = await wr.run(['secret', 'put', name, '--config', cfg], value + '\n');
    if (put.code !== 0) throw new Error(`secret の登録に失敗しました（${name}）: ${cleanWranglerError(put.stderr || put.stdout).join(' ')}`);
  }
  log('使用量のトークンを Worker に追加しました。数分以内に、どの PC の設定画面にも使用量と料金が表示されます。');
  log('削除するには: npx wrangler secret delete USAGE_API_TOKEN --config ' + cfg);
}

/** 別のクラウドに参加済みの PC で、上書きして参加するときの合言葉。 */
export const OVERWRITE_WORD = 'overwrite';

// ---- hangar cloud status ----

/** 経過を人の読む形にする。now を注入できるようにして、テストが時計に依らないようにする。 */
const relative = (ms: number | null, now: number): string => {
  if (ms === null) return 'なし';
  const s = Math.max(0, Math.round((now - ms) / 1000));
  return s < 60 ? `${s} 秒前` : s < 3600 ? `${Math.round(s / 60)} 分前` : `${Math.round(s / 3600)} 時間前`;
};

/** status の 1 回の問い合わせの締め切り。黒穴のような宛先で永久に待たない。 */
const STATUS_TIMEOUT_MS = 10_000;

const NOT_SET_UP = 'クラウド同期: 未設定（hangar setup cloud か hangar cloud join <接続先の URL> を実行してください）';

export type CloudStatusOptions = {
  home: string;
  fetch?: typeof fetch;
  port?: number;
  now?: () => number;
};

/**
 * 本文をいつから上げるかの 1 行。
 * 床が正しいかどうかは、刻まれた時刻を見せない限り利用者に確かめようがない。
 * 0 は床なしなので、全部上げると素直に言う（hangar cloud backfill の後がこれである）。
 */
function transcriptFloorLine(from: number): string {
  if (from <= 0) return 'トランスクリプト: この PC のトランスクリプトをすべてアップロードします';
  return `トランスクリプト: ${new Date(from).toISOString()} 以降に更新された分をアップロードします（それより前の分は hangar cloud backfill でアップロードし直せます）`;
}

/**
 * cloud.json、Worker の /health、手元のサーバの同期の状態を並べる。
 * 「未参加」と「壊れている」を分けて見せる。分けないと、権限の事故を参加し直しで潰しに行くことになる。
 * アカウント ID は出さない。画面共有と貼り付けで漏れる値を、見て嬉しくもないのに置かない。
 */
export async function cloudStatus(o: CloudStatusOptions): Promise<string> {
  const fetchFn = o.fetch ?? realFetch;
  const now = o.now ?? Date.now;
  const read = readCloudConfig(o.home);
  if (read.state === 'absent') return NOT_SET_UP;
  if (read.state === 'legacy') return `クラウド同期: 古い形式の設定のため停止しています\n${legacyConfigMessage(o.home)}`;
  if (read.state === 'broken' || !read.config) return `クラウド同期: 設定を読み取れません\n${brokenConfigMessage(o.home)}`;
  const c = read.config;

  const lines: string[] = [];
  // Worker の互換の版。届かなければ null（不明）である。
  let workerCompat: number | null = null;
  try {
    const r = await fetchFn(`${c.url}/health`, { headers: compatHeaders(), signal: AbortSignal.timeout(STATUS_TIMEOUT_MS) });
    const j = r.ok ? ((await r.json()) as { ok?: boolean; version?: string; compat?: unknown }) : null;
    // 版を返さない Worker は、版番号を入れる前の古い Worker である（版 0）。
    if (j?.ok) workerCompat = typeof j.compat === 'number' ? parseCompat(String(j.compat)) : 0;
    lines.push(`Worker: ${c.url}（${j?.ok ? `ok, ${j.version ?? '?'}` : `HTTP ${r.status}`}）`);
  } catch (e) {
    lines.push(`Worker: ${c.url}（接続できません: ${e instanceof Error ? e.message : String(e)}）`);
  }
  lines.push(`互換バージョン: この PC ${COMPAT_VERSION}、Worker ${workerCompat ?? '不明'}`);
  lines.push(c.workerName ? `役割: setup を実行した PC（Worker ${c.workerName}）` : '役割: 参加した PC（teardown はできません）');
  lines.push(transcriptFloorLine(readTranscriptsFrom(o.home)));
  lines.push(`アカウント ID と暗号鍵は ${cloudConfigPath(o.home)} にあります（漏えいを防ぐため表示しません）。`);
  try {
    const token = fs.readFileSync(path.join(o.home, 'token'), 'utf8').trim();
    const r = await fetchFn(`http://127.0.0.1:${o.port ?? 4177}/api/sync/status`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(STATUS_TIMEOUT_MS) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const s = (await r.json()) as SyncStatusDto;
    const t = now();
    const limited = typeof s.limitedUntil === 'number' ? `、無料枠の上限に達したため ${new Date(s.limitedUntil).toISOString()} まで停止しています` : '';
    lines.push(
      `同期: ${s.state}${s.error ? `（${s.error}）` : ''}${limited}、未送信 ${s.pending} 件、最終受信 ${relative(s.lastPullAt, t)}、最終送信 ${relative(s.lastPushAt, t)}、PC ${s.deviceCount} 台`,
    );
    // cloud.json はあるのに off なのは、サーバが cloud.json を書く前に起動していたときである（サーバは起動したときにだけ読む）。
    if (s.state === 'off') lines.push('サーバーはクラウド同期の設定を起動時にだけ読み取ります。アプリを終了して開き直すと同期が始まります（hangar start で起動している場合は、停止してから起動し直してください）。');
  } catch {
    lines.push('同期: サーバーは停止中（hangar start で起動すると同期が始まります）');
  }
  return lines.join('\n');
}

/**
 * hangar cloud backfill。
 *
 * 本文は既定では「クラウドを使い始めた後に動いたもの」だけを上げる。
 * 参加より前に止まっている本文も上げたくなったときの道がこれである。
 * 床（sync_state の transcriptsFrom）を 0 に落とすだけなので、サーバを立て直さなくても次の走査から効く。
 *
 * 参加していない端末では何もしない。
 * 索引の DB をここで作ってしまうと、まだ何も持っていない home に入れ物だけが残る。
 */
export function cloudBackfill(o: { home: string }): string {
  const read = readCloudConfig(o.home);
  if (read.state === 'absent') return NOT_SET_UP;
  if (read.state === 'legacy') return `クラウド同期: 古い形式の設定のため停止しています\n${legacyConfigMessage(o.home)}`;
  if (read.state === 'broken' || !read.config) return `クラウド同期: 設定を読み取れません\n${brokenConfigMessage(o.home)}`;
  const { from } = backfillTranscripts(o.home);
  const lines = ['参加より前のトランスクリプトもアップロードし直します。次の走査から、この PC のトランスクリプトをすべてクラウドへ送信します。'];
  if (from > 0) lines.push(`これまでは ${new Date(from).toISOString()} より後に更新されたトランスクリプトだけをアップロードしていました。`);
  lines.push('転送量は無料枠から差し引かれます。件数と大きさは hangar cloud status の「未送信」で確認してください。');
  return lines.join('\n');
}

// ---- hangar cloud teardown ----

/** 他端末の本文の置き場は 0700、中身は 0600。会話の本文そのものである。 */
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

/**
 * 設定ファイルの写しを置く入れ物の名前。
 * 端末 ID の下に置く（remote/<端末 ID>/_config/<相対パス>）ので、本文と同じ並びになる。
 * 本文は必ず projects/ の下なので、この名前と衝突しない。
 */
const CONFIG_DIR = '_config';

/** 一覧を何回まで辿るか。進まない応答や、際限のない一覧で回り続けないための歯止めである。 */
const MAX_FILE_PAGES = 200;

/** 失敗の報告に載せる wrangler の出力の行数の上限。 */
const MAX_REASON_LINES = 12;

/**
 * wrangler の出力を、報告に載せられる形にする。
 * 1 行目だけを取ると、本当の理由（[code: 10008] など）が落ちて、どの案内に当たるのか読めない。
 * アカウント ID のような長い 16 進は伏せる。色の指定も落とす。
 */
export function cleanWranglerError(text: string, maxLines = MAX_REASON_LINES): string[] {
  const lines = text
    // eslint-disable-next-line no-control-regex -- 端末の色指定を落とす
    .replace(/\u001b\[[0-9;]*[A-Za-z]/g, '')
    .replace(/\b[0-9a-f]{32,}\b/gi, '<マスク済み>')
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => l.trim() !== '');
  if (lines.length <= maxLines) return lines;
  return [...lines.slice(0, maxLines), `（残り ${lines.length - maxLines} 行は省略しました）`];
}

export type RescueResult = { downloaded: number; already: number; failed: { key: string; message: string }[] };

/**
 * 版 8 までの Worker の索引の 1 行（平文のメタと平文の鍵名）。
 * teardown が、作り直しの前の Worker から本文を降ろすのに使う（版 1 の cloud.json の道）。
 * shared とサーバからは封じた形（互換の版 9）に置き換えて消したので、この形はここにだけ持つ。
 */
export type LegacyFileEntry = { key: string; path: string; kind: 'transcript' | 'config'; sha256: string; size: number; mtime: number; encrypted: boolean; seq: number; deviceId: string; uploadedAt: number; storedSize: number };

/**
 * 版 8 までの本文の鍵。参加用の秘密から HKDF（SHA-256）で導く。
 * サーバからは消した（版 9 の本文は世代鍵から導く）ので、teardown のためにここにだけ写しを持つ。
 * 版 1 の cloud.json の teardown（旧い Worker の片付け）のほかに使わない。
 * teardown の版 1 の道でだけ使う（export は cloud.test.ts が古い本文を封じるためだけにある）。
 */
export function legacyFileKey(joinSecret: string): Buffer {
  return Buffer.from(hkdfSync('sha256', Buffer.from(joinSecret, 'utf8'), 'hangar-salt-v1', 'hangar-file-v1', 32));
}

/**
 * R2 の 1 件を手元のどこへ置くか。
 * 鍵と相対パスが同じファイルを指していることも確かめる。
 * 復号と SHA-256 は「その申告どおりのもの」しか見ないので、
 * 正しく暗号化された別のファイルへ丸ごと差し替えられたときに気付けない。
 * 鍵名は版 8 までの形（`transcripts/<端末>/...`、`config/<端末>/<相対パス>`）である。
 */
export function rescueTargetPath(home: string, e: LegacyFileEntry): string {
  if (e.kind === 'config') {
    if (!isSafeKeyId(e.deviceId)) throw new Error(`PC の ID が不正です: ${e.deviceId}`);
    if (!isSafeRelPath(e.path) || e.key !== `config/${e.deviceId}/${e.path}`) throw new Error(`設定ファイルのキーと相対パスが食い違っています: ${e.key}`);
    // 端末ごとに分ける。分けないと、2 台の同じ名前の設定（CLAUDE.md など）が同じ場所へ降りて、
    // 中身が違えば後から降ろした方が前の方を消してしまう。R2 の鍵も端末ごとに分かれている。
    return path.join(remoteRoot(home), e.deviceId, CONFIG_DIR, ...e.path.split('/'));
  }
  const parts = path.posix.normalize(e.path).split('/');
  const suffix = parts.slice(2).join('/');
  if (parts[0] !== 'projects' || parts.length < 3 || suffix === '' || e.key !== `transcripts/${e.deviceId}/${suffix}.gz`) {
    throw new Error(`トランスクリプトのキーと相対パスが食い違っています: ${e.key}`);
  }
  return remoteTranscriptPath(home, e.deviceId, e.path);
}

/** 版 8 までの Worker の索引を読む口（GET /files）。返る行は平文のメタの形である。 */
type LegacyFileLister = { listFiles(since: number, limit: number): Promise<{ files: unknown[]; nextSeq: number; more: boolean }> };
/** 本文を暗号化されたまま取る口（GET /files/:key）。 */
type RawFileGetter = Pick<WireCloudClient, 'getFile'>;

/** R2 にある本文の一覧を最後まで辿る。 */
export async function listAllFiles(client: LegacyFileLister): Promise<LegacyFileEntry[]> {
  const out: LegacyFileEntry[] = [];
  let since = 0;
  for (let page = 0; page < MAX_FILE_PAGES; page++) {
    const r = await client.listFiles(since, PULL_LIMIT);
    out.push(...(r.files as LegacyFileEntry[]));
    if (!r.more || r.nextSeq <= since) return out;
    since = r.nextSeq;
  }
  throw new Error('R2 の一覧の取得が終わりません。もう一度実行してください');
}

/** 1 件を降ろす。復号して gzip を解き、指紋が合ったものだけを本物の名前にする。 */
async function downloadOne(client: RawFileGetter, e: LegacyFileEntry, target: string, key: Buffer): Promise<void> {
  // 決定 5 のとおり、本文は必ず暗号化して置く。puller と同じ判定にする。
  // 申告を鵜呑みにして平文の道を開けておくと、参加用の秘密を持たない Worker の側から
  // ~/.agent-hangar/remote に中身を仕込める（sha256 は索引も本体も相手が握るので守りにならない）。
  if (!e.encrypted) throw new Error(`ファイルが暗号化されていません: ${e.key}`);
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: DIR_MODE });
  const tmp = `${target}.part`;
  try {
    fs.rmSync(tmp, { force: true });
    const body = await client.getFile(e.key);
    const sink = (): fs.WriteStream => fs.createWriteStream(tmp, { mode: FILE_MODE });
    // pipeline でつなぐ。裸の pipe だと復号の error が未処理になってプロセスごと落ちる。
    await pipeline(body, decryptStream(key), createGunzip(), sink());
    const sha = await sha256Stream(fs.createReadStream(tmp));
    if (sha !== e.sha256) throw new Error(`ファイルの SHA-256 が一致しません: ${e.key}`);
    fs.renameSync(tmp, target);
    fs.utimesSync(target, new Date(e.mtime), new Date(e.mtime));
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

/**
 * R2 にしか無い本文を手元へ降ろす。
 * teardown は R2 のオブジェクトを全部消すので、他端末にしか本文が無いセッションは、
 * ここで写しを取らないと消した瞬間に失われる。
 * 自分が上げた本文は原本が ~/.claude にあるので、原本があるものは降ろさない。
 */
export async function rescueRemoteBodies(o: {
  home: string;
  entries: LegacyFileEntry[];
  joinSecret: string;
  client: RawFileGetter;
  deviceId?: string;
  claudeDir?: string;
  log?: (line: string) => void;
}): Promise<RescueResult> {
  const log = o.log ?? ((l: string) => console.log(l));
  const key = legacyFileKey(o.joinSecret);
  const r: RescueResult = { downloaded: 0, already: 0, failed: [] };
  for (const e of o.entries) {
    try {
      // 自分が上げた本文で、原本が手元にあるものは降ろし直さない。
      if (e.kind === 'transcript' && o.deviceId && e.deviceId === o.deviceId && o.claudeDir && fs.existsSync(path.join(o.claudeDir, e.path))) {
        r.already++;
        continue;
      }
      const target = rescueTargetPath(o.home, e);
      if (fs.existsSync(target) && (await sha256Stream(fs.createReadStream(target))) === e.sha256) {
        r.already++;
        continue;
      }
      await downloadOne(o.client, e, target, key);
      log(`ダウンロードしました: ${e.key}`);
      r.downloaded++;
    } catch (err) {
      r.failed.push({ key: e.key, message: err instanceof Error ? err.message : String(err) });
    }
  }
  return r;
}

/**
 * 版 2 のクラウドの R2 の本文を手元へ降ろす。
 * 索引は封じたメタなので、cloud.json の世代鍵で開く（同期と同じ openSealedFile と SealedCloudClient を使う）。
 * 置き場は元の PC の ID の下（remote/<origin>/）で、作り直しで上げ直した写しも元の PC の下に戻る。
 * 開けない行（手元に鍵の無い世代、付け替えられたメタ）は降ろせないものに数える。消すと失われるからである。
 * 戻り値の keys は、索引にある全部の R2 の鍵名で、開けたかどうかに依らない（消すのに使う）。
 */
export async function rescueSealedBodies(o: {
  home: string;
  cloud: CloudConfig;
  wire: WireCloudClient;
  deviceId?: string;
  claudeDir?: string;
  /** 自端末の $CODEX_HOME。自分の Codex の会話の原本があるかを見るために使う。省くと見ない（降ろす）。 */
  codexHome?: string;
  log?: (line: string) => void;
}): Promise<{ keys: string[]; rescued: RescueResult }> {
  const log = o.log ?? ((l: string) => console.log(l));
  const ring = await Keyring.fromConfig(o.cloud);
  const sealed = new SealedCloudClient(o.wire, ring, o.deviceId ?? '');
  const raw: Awaited<ReturnType<WireCloudClient['listFiles']>>['files'] = [];
  let since = 0;
  for (let page = 0; ; page++) {
    if (page >= MAX_FILE_PAGES) throw new Error('R2 の一覧の取得が終わりません。もう一度実行してください');
    const r = await o.wire.listFiles(since, PULL_LIMIT);
    raw.push(...r.files);
    if (!r.more || r.nextSeq <= since) break;
    since = r.nextSeq;
  }
  const r: RescueResult = { downloaded: 0, already: 0, failed: [] };
  for (const f of raw) {
    try {
      const e = await openSealedFile(ring, f);
      if (!e) throw new Error(ring.at(f.epoch) ? 'インデックスの行を復号できません' : `世代 ${f.epoch} の暗号鍵がこの PC にありません`);
      const origin = e.origin || e.deviceId;
      // 自分の本文で、原本が手元にあるものは降ろし直さない。
      if (e.kind === 'transcript' && o.deviceId && origin === o.deviceId && o.claudeDir && fs.existsSync(path.join(o.claudeDir, e.path))) {
        r.already++;
        continue;
      }
      // opencode の本文の写し（opencode/<会話>.json）は、ほかの PC のものは Claude と同じく remote/<元の PC>/opencode/ に降ろす。
      // 自分の会話は原本が opencode の記録の置き場にあり、上げた書き出しも ~/.agent-hangar/opencode/export にあるので、それがあれば降ろし直さない。
      const own = agentOfSyncPath(e.path);
      const ownFile = own === null ? null : AGENT_SYNC[own.provider].exportFile;
      if (e.kind === 'transcript' && own && ownFile && o.deviceId && origin === o.deviceId && fs.existsSync(ownFile(o.home, own.sessionId))) {
        r.already++;
        continue;
      }
      // Codex の本文の写し（codex/sessions/... か codex/archived_sessions/...）も、自分の会話で原本が $CODEX_HOME にあれば降ろし直さない。
      // 原本は .jsonl.zst に圧縮されていることもある。原本の無い自分の会話は、消すと失われるので降ろす。
      const codexOriginal = own?.provider === 'codex' && o.codexHome ? codexHomePath(o.codexHome, e.path) : null;
      if (e.kind === 'transcript' && codexOriginal && o.deviceId && origin === o.deviceId && resolvePhysical(codexOriginal) !== null) {
        r.already++;
        continue;
      }
      let target: string;
      if (e.kind === 'config') {
        if (!isSafeKeyId(origin)) throw new Error(`PC の ID が不正です: ${origin}`);
        if (!isSafeRelPath(e.path)) throw new Error(`設定ファイルの相対パスが不正です: ${e.key}`);
        target = path.join(remoteRoot(o.home), origin, CONFIG_DIR, ...e.path.split('/'));
      } else {
        target = remoteTranscriptPath(o.home, origin, e.path);
      }
      if (fs.existsSync(target) && (await sha256Stream(fs.createReadStream(target))) === e.sha256) {
        r.already++;
        continue;
      }
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: DIR_MODE });
      const tmp = `${target}.part`;
      try {
        fs.rmSync(tmp, { force: true });
        // 復号と gzip の展開は SealedCloudClient が行う。
        await pipeline(await sealed.getFile(e.key, e.epoch), fs.createWriteStream(tmp, { mode: FILE_MODE }));
        if ((await sha256Stream(fs.createReadStream(tmp))) !== e.sha256) throw new Error(`ファイルの SHA-256 が一致しません: ${e.key}`);
        fs.renameSync(tmp, target);
        fs.utimesSync(target, new Date(e.mtime), new Date(e.mtime));
      } catch (err) {
        fs.rmSync(tmp, { force: true });
        throw err;
      }
      log(`ダウンロードしました: ${e.key}`);
      r.downloaded++;
    } catch (err) {
      r.failed.push({ key: f.key, message: err instanceof Error ? err.message : String(err) });
    }
  }
  return { keys: raw.map((f) => f.key), rescued: r };
}

export type TeardownOptions = {
  home: string;
  wrangler?: WranglerRunner;
  fetch?: typeof fetch;
  /** 版 2 のクラウドの Worker の口。省くと cloud.json の接続先へ fetch で話す。試験が偽の Worker を渡す。 */
  wire?: WireCloudClient;
  confirm?: ConfirmWord;
  log?: (line: string) => void;
  cloudDir?: string;
  /** 自端末の ID。自分が上げた本文を降ろし直さないために使う。 */
  deviceId?: string;
  /** 自端末の ~/.claude。原本があるかを見るために使う。 */
  claudeDir?: string;
  /** 自端末の $CODEX_HOME。自分の Codex の会話の原本があるかを見るために使う。 */
  codexHome?: string;
};

/**
 * Worker、R2、D1 を消す。setup cloud を実行した端末だけが使え、確認を 2 段で取る。
 * 消す前に、R2 にしか無い本文を手元へ降ろす。1 件でも降ろせなければ、何も消さずに止める。
 * Cloudflare 側が全部消えたときだけ、手元の cloud.json と wrangler.jsonc を消す。
 * 1 つでも残ったら手元の設定を残して false を返す。もう一度実行すれば続きから消せる。
 * cloud.json が無く setup の下書き（cloud-setup-pending.json）だけがあれば、下書きの Worker、D1、R2 を同じ順で消し、最後に下書きを消す。
 */
export async function runTeardown(o: TeardownOptions): Promise<boolean> {
  const log = o.log ?? ((l: string) => console.log(l));
  const confirm = o.confirm ?? promptWord;
  // 版 2（今の形）と版 1（参加用の秘密を持つ旧い形）の cloud.json の両方を片付けられる。
  // 版 1 の道は、0.9.0 に上げた後でも旧い Worker を片付けるためにある（作り直しの手順の 2）。
  // どちらも、消す前に R2 にしか無い本文を手元へ降ろし、1 件でも降ろせなければ何も消さずに止める。
  // cloud.json が無く、setup の下書きだけがあるとき（確認の段で止めて放置した）は、下書きの Worker、D1、R2 を片付ける。
  // 下書きは版 2 の設定と同じ形で、端末トークンも暗号鍵も入っている。片付け終えたら下書きも消す。
  const now = readCloudConfig(o.home);
  if (now.state === 'broken') throw new Error(brokenConfigMessage(o.home));
  let c: { url: string; workerName: string | null; accountId: string | null; dbName: string | null; bucketName: string | null };
  let legacy: ReturnType<typeof readLegacyCloudConfig>['config'] = null;
  let v2: CloudConfig | null = null;
  let fromDraft = false;
  if (now.state === 'ok' && now.config) {
    c = v2 = now.config;
  } else {
    const read = readLegacyCloudConfig(o.home);
    if (read.state === 'broken') throw new Error(brokenConfigMessage(o.home));
    const draft = read.config ? null : readSetupPending(o.home);
    if (read.config) {
      c = legacy = read.config;
    } else if (draft) {
      c = v2 = draft.conf;
      fromDraft = true;
      log(`完了していない setup の下書き（${setupPendingPath(o.home)}）にある Worker を削除します。`);
    } else {
      throw new Error('クラウド同期は未設定です');
    }
  }
  /** 片付けで読んだ設定のファイル。途中で止めるときは残し、全部消せたら消す。 */
  const configFile = fromDraft ? setupPendingPath(o.home) : cloudConfigPath(o.home);
  if (!c.workerName || !c.dbName || !c.bucketName) {
    throw new Error('teardown は setup cloud を実行した PC でだけ使えます。参加した PC では cloud.json を削除するだけにしてください');
  }

  log(`Worker ${c.workerName}、D1 ${c.dbName}、R2 ${c.bucketName} を削除します。元に戻せません。`);
  log('同期したメタデータと、R2 にあるトランスクリプトのコピーはすべて失われます。');

  // 消す前に、R2 にしか無い本文を手元へ降ろす。
  let keys: string[];
  let rescued: RescueResult;
  if (legacy === null) {
    const cloud = v2!;
    // 版 2 の Worker とだけ話す（版 9 に届かない Worker なら HttpCloudClient が断る）。
    const wire = o.wire ?? new HttpCloudClient({ url: cloud.url, token: cloud.deviceToken, fetch: o.fetch ?? realFetch });
    let r: { keys: string[]; rescued: RescueResult };
    try {
      log('R2 にあるトランスクリプトのうち、この PC にコピーが無いものを先にダウンロードします。');
      r = await rescueSealedBodies({ home: o.home, cloud, wire, deviceId: o.deviceId, claudeDir: o.claudeDir, codexHome: o.codexHome, log });
    } catch (e) {
      throw new Error(`R2 にあるトランスクリプトの一覧を読み取れませんでした（${e instanceof Error ? e.message : String(e)}）。削除されるものが分からないため、中止しました`);
    }
    keys = r.keys;
    rescued = r.rescued;
    log(`R2 にはトランスクリプトが ${keys.length} 件あります。`);
  } else {
    // 旧い Worker は互換の版が 9 に届かないので、版の下限を外して読む。読むだけで、何も書かない。
    const client = new HttpCloudClient({ url: legacy.url, token: legacy.deviceToken, fetch: o.fetch ?? realFetch, minWorkerCompat: 0 });
    let entries: LegacyFileEntry[];
    try {
      entries = await listAllFiles(client);
    } catch (e) {
      throw new Error(`R2 にあるトランスクリプトの一覧を読み取れませんでした（${e instanceof Error ? e.message : String(e)}）。削除されるものが分からないため、中止しました`);
    }
    log(`R2 にはトランスクリプトが ${entries.length} 件あります。この PC にコピーが無いものを先にダウンロードします。`);
    rescued = await rescueRemoteBodies({ home: o.home, entries, joinSecret: legacy.joinSecret, client, deviceId: o.deviceId, claudeDir: o.claudeDir, log });
    keys = entries.map((e) => e.key);
  }
  log(`${rescued.downloaded} 件をこの PC にダウンロードしました（${rescued.already} 件はすでにこの PC にあります）。`);
  if (rescued.failed.length > 0) {
    log('ダウンロードできなかったトランスクリプト:');
    for (const f of rescued.failed) log(`  ${f.key}: ${f.message}`);
    throw new Error(`${rescued.failed.length} 件をダウンロードできませんでした。削除すると元に戻せないため、中止しました。しばらく待ってからもう一度実行してください`);
  }

  if ((await confirm(`続けるには Worker の名前を入力してください（${c.workerName}）。`, c.workerName)) !== true) {
    log('中止しました');
    return false;
  }
  if ((await confirm('削除するには delete と入力してください。', 'delete')) !== true) {
    log('中止しました');
    return false;
  }

  const cfg = wranglerConfigPath(o.home);
  // 設定ファイルが無ければ付けない。無いパスを --config に渡すと、どの手順も始まらずに終わる。
  const withCfg = fs.existsSync(cfg) ? ['--config', cfg] : [];
  const wr = o.wrangler ?? new WranglerRunner({ cloudDir: o.cloudDir ?? requireCloudDir(), accountId: c.accountId, log });
  const deleted: string[] = [];
  const failures: { label: string; reason: string[] }[] = [];
  const step = async (label: string, args: string[], input?: string): Promise<void> => {
    const r = await wr.run(args, input);
    if (r.code !== 0) {
      // 1 行目は wrangler の見出し（A request to the Cloudflare API ... failed.）で、
      // 本当の理由（bucket is not empty [code: 10008] など）はその後ろにある。最後まで見せる。
      const reason = cleanWranglerError(`${r.stderr}\n${r.stdout}`);
      failures.push({ label, reason });
      log(`失敗: ${label}`);
      for (const l of reason) log(`  ${l}`);
    } else {
      deleted.push(label);
      log(`完了: ${label}`);
    }
  };

  /**
   * 途中で止めるときの報告。
   * 手元の cloud.json は残す。Worker の名前もアカウントも暗号鍵（版 1 では参加用の秘密）もここにしか無いので、
   * 消すと、残った資源を片付ける道も R2 の本文を復号する道も同時に失う。
   */
  const stopHere = (): false => {
    log('');
    if (deleted.length > 0) {
      log('削除したもの:');
      for (const d of deleted) log(`  ${d}`);
    }
    log('残ったもの:');
    for (const f of failures) {
      log(`  ${f.label}`);
      for (const l of f.reason) log(`    ${l}`);
    }
    log('');
    log(`${configFile} は削除していません。Worker の名前、アカウント、暗号鍵はここにしか無いためです。`);
    log('修正してから hangar cloud teardown をもう一度実行すると、残った分だけを続きから削除できます。');
    log('R2 のバケットが「空でない」ために削除できない場合は、インデックスに無いオブジェクトが残っています。ダッシュボードでバケットを空にしてから実行してください。');
    return false;
  };

  // R2 を先に空にする。
  // --remote を付ける。付けないと wrangler は手元の miniflare の入れ物を消して、R2 には何もしない。
  for (const key of keys) await step(`R2 object ${key}`, ['r2', 'object', 'delete', `${c.bucketName}/${key}`, '--remote', ...withCfg]);
  await step(`R2 bucket ${c.bucketName}`, ['r2', 'bucket', 'delete', c.bucketName, ...withCfg]);
  // Worker は R2 の中身へ手が届く唯一の入口である（GET /files と GET /files/<key>）。
  // オブジェクトが残っているうちに消すと、次の teardown は一覧すら読めず、本文も降ろせなくなる。
  if (failures.length > 0) return stopHere();

  await step(`Worker ${c.workerName}`, ['delete', '--name', c.workerName, ...withCfg], 'y\n');
  await step(`D1 ${c.dbName}`, ['d1', 'delete', c.dbName, '-y', ...withCfg]);
  if (failures.length > 0) return stopHere();

  fs.rmSync(configFile, { force: true });
  fs.rmSync(cfg, { force: true });
  if (fromDraft) {
    log('setup の下書きを削除しました。');
  } else {
    // 同じ Worker の下書きが残っていれば、もう続けられないので一緒に消す。
    if (readSetupPending(o.home)?.conf.workerName === c.workerName) fs.rmSync(setupPendingPath(o.home), { force: true });
    log('cloud.json を削除しました。');
    log('他の PC は、hangar を 0.9.0 以降に更新してから、新しいクラウドの参加コードで「上書きして参加」してください。');
    log('他の PC の古い設定は、上書きの前に自動でその PC の ~/.agent-hangar/backups/ にバックアップされます。');
  }
  log(`この PC にダウンロードしたトランスクリプトは ${remoteRoot(o.home)} に保存されています。`);
  return true;
}
