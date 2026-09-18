import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { createGunzip } from 'node:zlib';
import { cloudConfigPath, type CloudConfig, readCloudConfig, remoteRoot, saveCloudConfig } from '@agent-hangar/server';
// 同期の本体（暗号、置き場の組み立て、Worker の叩き方）はサーバ側の実装を借りる。
// ここで写しを作ると、鍵の導出やパスの検査が片方だけ直されて食い違う。
import type { CloudClient } from '@agent-hangar/server/src/sync/client.ts';
import { HttpCloudClient } from '@agent-hangar/server/src/sync/client.ts';
import { decryptStream, deriveFileKey, sha256Stream } from '@agent-hangar/server/src/sync/crypto.ts';
import { remoteTranscriptPath } from '@agent-hangar/server/src/sync/puller.ts';
import { configKey, decodeJoinToken, encodeJoinToken, isSafeRelPath, PULL_LIMIT, type FileEntry, type JoinResponse, type SyncStatusDto } from '@agent-hangar/shared';
import { parseAccountId, parseDatabaseId, parseWorkerUrl, WranglerRunner } from './wrangler.ts';

export type DeviceLike = { id: string; name: string; platform: string };

/** 取り返しの付かない操作の確認。合言葉をそのまま打ってもらう。 */
export type ConfirmWord = (question: string, word: string) => Promise<boolean>;

export type SetupCloudOptions = {
  home: string;
  device: DeviceLike;
  /** Worker の名前。D1 は同名、R2 は <name>-files になる。 */
  name?: string;
  rotateSecret?: boolean;
  wrangler?: WranglerRunner;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  cloudDir?: string;
  log?: (line: string) => void;
  confirm?: ConfirmWord;
};

const HEALTH_TIMEOUT_MS = 120_000;
const HEALTH_INTERVAL_MS = 5000;
const JOIN_RETRIES = 6;

/** --rotate-secret の確認で打ってもらう合言葉。y の押し間違いでは通らないようにする。 */
export const ROTATE_WORD = 'rotate';

/** リポジトリ内の packages/cloud。CLI の src からの相対で探す。 */
export function defaultCloudDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../cloud');
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
 * 「まだ参加していない」と混ぜない。混ぜて参加し直すと別の参加用の秘密が入り、R2 の既存の暗号化ファイルを誰も復号できなくなる。
 */
export function brokenConfigMessage(home: string): string {
  return `${cloudConfigPath(home)} を読めません（壊れているか、権限の事故です）。参加し直すと別の参加用の秘密が入り、R2 にある既存の暗号化ファイルを復号できなくなります。ファイルを直すか控えから戻してから、もう一度実行してください。`;
}

export const sha256Hex = (s: string): string => createHash('sha256').update(s).digest('hex');
const realSleep = (ms: number): Promise<void> => new Promise<void>((r) => setTimeout(r, ms));
const realFetch: typeof fetch = (...a) => fetch(...a);

/** 合言葉をそのまま打ってもらう確認。 */
export function promptWord(question: string, word: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) =>
    rl.question(`${question}\n続けるなら ${word} と入力してください: `, (a) => {
      rl.close();
      resolve(a.trim() === word);
    }),
  );
}

/** 標準入力から一度に受け取る上限。参加トークンは 200 字ほどなので、これを超える入力は貼り間違いである。 */
const MAX_STDIN_BYTES = 64 * 1024;

/**
 * 参加トークンを標準入力から受け取る。
 * argv に載せると ps -axww とシェルの履歴から読めてしまう。
 * 折り返しが入っていても decodeJoinToken が空白を落とすので、そのまま貼ってよい。
 */
export async function readJoinToken(): Promise<string> {
  if (!process.stdin.isTTY) {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of process.stdin) {
      const b = c as Buffer;
      size += b.length;
      if (size > MAX_STDIN_BYTES) throw new Error('標準入力が長すぎます。参加トークンだけを渡してください');
      chunks.push(b);
    }
    return Buffer.concat(chunks).toString('utf8');
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await new Promise<string>((resolve) => rl.question('参加トークンを貼り付けてください（1Password の項目から）: ', resolve));
  } finally {
    rl.close();
  }
}

/** /health が通るまで待つ。デプロイ直後は workers.dev の反映待ちで error code 1042 が返る。 */
export async function waitForHealth(url: string, o: { fetch: typeof fetch; sleep: (ms: number) => Promise<void>; timeoutMs?: number; intervalMs?: number }): Promise<boolean> {
  const timeout = o.timeoutMs ?? HEALTH_TIMEOUT_MS;
  const interval = o.intervalMs ?? HEALTH_INTERVAL_MS;
  for (let waited = 0; ; waited += interval) {
    try {
      const r = await o.fetch(`${url}/health`);
      if (r.ok && ((await r.json()) as { ok?: boolean }).ok === true) return true;
    } catch {
      // 接続できないうちは待つ。
    }
    if (waited + interval > timeout) return false;
    await o.sleep(interval);
  }
}

export type JoinOptions = {
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  retries?: number;
  /**
   * 403 も待って試し直すか。
   * setup の直後は、secret put で入れ替えた秘密がまだ届いていない isolate が古い秘密で断ることがある。
   * hangar join のように利用者が貼ったトークンを検査する場面では false にする。打ち間違いを 30 秒待たせない。
   */
  retryForbidden?: boolean;
  log?: (line: string) => void;
};

/**
 * POST /join で端末を登録する。
 * 秘密は本文に載せる。URL にもヘッダにも argv にも載せない。
 */
export async function joinWorker(url: string, secret: string, device: DeviceLike, o: JoinOptions): Promise<JoinResponse> {
  const retries = o.retries ?? JOIN_RETRIES;
  for (let i = 0; ; i++) {
    const r = await o.fetch(`${url}/join`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ secret, device }) });
    if (r.status === 201) return (await r.json()) as JoinResponse;
    const waitable = r.status === 503 || (r.status === 403 && o.retryForbidden === true);
    if (waitable && i < retries) {
      o.log?.('Worker への反映を待っています');
      await o.sleep(HEALTH_INTERVAL_MS);
      continue;
    }
    // 応答の本文は出さない。秘密が混じる経路を作らない。
    if (r.status === 403) throw new Error('参加用の秘密が違います。参加トークンを確かめてください');
    throw new Error(`参加に失敗しました（HTTP ${r.status}）`);
  }
}

/**
 * 実物の資源を指す wrangler の設定を ~/.agent-hangar/cloud/wrangler.jsonc に書く。
 * アカウント ID はここに書かず、実行のたびに環境変数で渡す。
 */
export function writeWranglerConfig(home: string, o: { name: string; main: string; dbName: string; dbId: string; bucketName: string }): string {
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
    vars: {},
  };
  const head = [
    '// hangar setup cloud が生成した。手で書き換えても次の実行で上書きされる。',
    '// アカウント ID は環境変数で渡すので、ここには書かない。',
    '// JOIN_SECRET_HASH は wrangler secret で入れるので、ここには書かない。',
    '',
  ].join('\n');
  fs.writeFileSync(file, head + JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
  return file;
}

/** --rotate-secret の警告と確認。作り直すと R2 の既存の暗号化ファイルを誰も復号できなくなる。 */
async function confirmRotate(log: (l: string) => void, confirm: ConfirmWord): Promise<void> {
  log('');
  log('警告: 参加用の秘密を作り直そうとしています。');
  log('この秘密は本文の暗号鍵の材料（deriveFileKey の入力）です。');
  log('作り直すと、R2 にある既存の暗号化ファイルを、この端末を含めどの端末からも復号できなくなります。');
  log('先に R2 のバケットを空にするか、必要な本文を手元へ降ろしてから実行してください。');
  log('参加済みの他の端末も、作り直した後は新しい参加トークンで hangar join をやり直す必要があります。');
  if (!(await confirm('本当に参加用の秘密を作り直しますか。', ROTATE_WORD))) throw new Error('参加用の秘密の作り直しを取りやめました');
}

/** 参加トークンの渡し方の案内。標準出力に出す以上、残るものは残ると伝える。 */
function printJoinToken(log: (l: string) => void, joinToken: string): void {
  log('');
  log('参加トークン:');
  log('');
  log(joinToken);
  log('');
  log('渡し方: 1Password の共有 vault に新しい項目を作ってこの文字列を保存し、2 台目でそれを読んで hangar join <トークン> に渡してください。');
  log('貼るときに折り返しが入っても読めます。空白と改行は取り除いてから解釈します。');
  log('このトークンは参加用の秘密を含みます。標準出力に出した以上、端末のスクロールバックとシェルの記録（履歴やログ）にも残ります。');
  log('1Password に保存したら、スクロールバックを流すか、この端末の窓を閉じてください。');
  log('渡す相手は自分のもう 1 台だけです。他人と共有しないでください。');
  log('');
  log('hangar を再起動すると同期が始まります。');
}

/**
 * 利用者の Cloudflare アカウントに Worker と D1 と R2 を作ってデプロイし、自端末を参加させ、参加トークンを返す。
 * 二度目以降は既存の資源と秘密を再利用する。
 */
export async function runSetupCloud(o: SetupCloudOptions): Promise<{ url: string; joinToken: string }> {
  const log = o.log ?? ((l: string) => console.log(l));
  const fetchFn = o.fetch ?? realFetch;
  const sleep = o.sleep ?? realSleep;
  const cloudDir = o.cloudDir ?? defaultCloudDir();
  const name = o.name ?? 'hangar';
  const dbName = name;
  const bucketName = `${name}-files`;
  let wr = o.wrangler ?? new WranglerRunner({ cloudDir, accountId: null, log });

  // 0. 参加用の秘密を先に決める。
  // 壊れた cloud.json を「未参加」と読み替えて参加し直すと、別の秘密が入って既存の暗号化ファイルが読めなくなる。
  const read = readCloudConfig(o.home);
  if (read.state === 'broken') throw new Error(brokenConfigMessage(o.home));
  const prev = read.config;
  if (o.rotateSecret && prev) await confirmRotate(log, o.confirm ?? promptWord);
  if (o.rotateSecret && !prev) log('まだ参加用の秘密がないので、作り直しではなく新しく作ります。');
  const secret = prev && !o.rotateSecret ? prev.joinSecret : randomBytes(32).toString('base64url');

  // 1. アカウント
  let who = await wr.run(['whoami']);
  let accountId = who.code === 0 ? parseAccountId(who.stdout + who.stderr) : null;
  if (!accountId) {
    log('Cloudflare にログインします。ブラウザが開きます。');
    const code = await wr.runInteractive(['login']);
    if (code !== 0) throw new Error('wrangler login に失敗しました');
    who = await wr.run(['whoami']);
    accountId = who.code === 0 ? parseAccountId(who.stdout + who.stderr) : null;
    if (!accountId) throw new Error('アカウント ID を読めませんでした。wrangler whoami の出力を確かめてください');
  }
  wr = wr.withAccount(accountId);

  // 2. D1 と R2
  const info = await wr.run(['d1', 'info', dbName, '--json']);
  let dbId = info.code === 0 ? parseDatabaseId(info.stdout) : null;
  if (!dbId) {
    const created = await wr.run(['d1', 'create', dbName]);
    dbId = parseDatabaseId(created.stdout + created.stderr);
    if (created.code !== 0 || !dbId) throw new Error(`D1 の作成に失敗しました: ${created.stderr || created.stdout}`);
    log(`D1 ${dbName} を作りました`);
  } else {
    log(`D1 ${dbName} は既にあります`);
  }
  const bucket = await wr.run(['r2', 'bucket', 'create', bucketName]);
  if (bucket.code !== 0 && !/already exists/i.test(bucket.stderr + bucket.stdout)) throw new Error(`R2 の作成に失敗しました: ${bucket.stderr || bucket.stdout}`);
  log(bucket.code === 0 ? `R2 ${bucketName} を作りました` : `R2 ${bucketName} は既にあります`);

  // 3. 設定と 4. デプロイ
  const cfg = writeWranglerConfig(o.home, { name, main: path.join(cloudDir, 'src', 'index.ts'), dbName, dbId, bucketName });
  const dep = await wr.run(['deploy', '--config', cfg]);
  const url = parseWorkerUrl(dep.stdout + dep.stderr);
  if (dep.code !== 0 || !url) throw new Error(`デプロイに失敗しました: ${dep.stderr || dep.stdout}`);
  log(`デプロイしました: ${url}`);

  // 5. 参加用の秘密を Worker へ。平文は標準入力から渡し、argv には載せない。
  const put = await wr.run(['secret', 'put', 'JOIN_SECRET_HASH', '--config', cfg], sha256Hex(secret) + '\n');
  if (put.code !== 0) throw new Error(`secret の登録に失敗しました: ${put.stderr || put.stdout}`);

  // 6. health と 7. 参加
  log('Worker の反映を待っています（最大 2 分）');
  if (!(await waitForHealth(url, { fetch: fetchFn, sleep }))) {
    throw new Error(`${url}/health が 2 分以内に通りませんでした。しばらく待ってから hangar setup cloud をもう一度実行してください`);
  }
  const joined = await joinWorker(url, secret, o.device, { fetch: fetchFn, sleep, retryForbidden: true, log });

  // 8. 保存と表示
  const conf: CloudConfig = { url, joinSecret: secret, deviceToken: joined.deviceToken, workerName: name, accountId, dbName, bucketName, joinedAt: Date.now() };
  saveCloudConfig(o.home, conf);
  const joinToken = encodeJoinToken({ url, secret });
  printJoinToken(log, joinToken);
  return { url, joinToken };
}

// ---- hangar join ----

/** 参加し直しの確認で打ってもらう合言葉。 */
export const OVERWRITE_WORD = 'overwrite';

export type JoinCliOptions = {
  home: string;
  token: string;
  device: DeviceLike;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
  confirm?: ConfirmWord;
  /** 確認を省く。対話できない場面（標準入力が塞がっているとき）のための逃げ道である。 */
  force?: boolean;
};

/**
 * 参加トークンの宛先を人に見せる。
 * decodeJoinToken は URL の形（素の https の origin か loopback か）しか見ない。
 * 「どこに繋ごうとしているか」を判断できるのは利用者だけなので、必ず目に入れてもらう。
 */
function showDestination(log: (l: string) => void, url: string): void {
  log('');
  log('参加しようとしている宛先:');
  log('');
  log(`  ${url}`);
  log(`  ホスト: ${new URL(url).host}`);
  log('');
  log('参加トークンは、このクラウドの全セッションを読み書きできる秘密です。');
  log('自分が hangar setup cloud で作った宛先か、上のホストを目で確かめてください。');
  log('心当たりのないホストなら、この端末の会話の本文が相手のサーバへ上がります。');
}

/** 参加し直しの警告。参加用の秘密が変わると、前のクラウドの本文を復号できなくなる。 */
function warnRejoin(log: (l: string) => void, oldUrl: string, newUrl: string, sameUrl: boolean): void {
  log('');
  log(sameUrl ? '警告: 宛先は同じですが、参加用の秘密が違います（相手側で作り直されています）。' : '警告: この端末は既に別のクラウドに参加しています。');
  log('');
  log(`  いまの宛先: ${oldUrl}`);
  log(`  新しい宛先: ${newUrl}`);
  log('');
  log('参加用の秘密は本文の暗号鍵の材料（deriveFileKey の入力）です。');
  log('いまの秘密で暗号化された R2 のファイルは、参加し直した後、この端末では復号できなくなります。');
  log('元に戻すには、いま使っている参加トークンでもう一度 hangar join を実行することになります（1Password に残っていますか）。');
  log('~/.agent-hangar/remote に降ろし済みの本文は、そのまま手元に残ります。');
}

/**
 * 参加トークンでクラウド同期に参加し、cloud.json を書く。
 * setup を実行した端末ではないので、workerName、accountId、dbName、bucketName は null にする。
 */
export async function runJoin(o: JoinCliOptions): Promise<CloudConfig> {
  const log = o.log ?? ((l: string) => console.log(l));
  const confirm = o.confirm ?? promptWord;
  const read = readCloudConfig(o.home);
  // 壊れているのを「未参加」と読み替えて参加し直すと、別の参加用の秘密が入って既存の暗号化ファイルが読めなくなる。
  if (read.state === 'broken') throw new Error(brokenConfigMessage(o.home));

  const t = decodeJoinToken(o.token);
  const url = t.url.replace(/\/+$/, '');
  if (!o.force) {
    showDestination(log, url);
    if (!(await confirm('この宛先に参加しますか。', 'y'))) throw new Error('参加を取りやめました');
    const prev = read.config;
    // 宛先が同じでも、秘密が違えば既存の暗号化ファイルは読めなくなる。見るのは 2 つである。
    if (prev && (prev.url !== url || prev.joinSecret !== t.secret)) {
      warnRejoin(log, prev.url, url, prev.url === url);
      if (!(await confirm('本当に cloud.json を上書きしますか。', OVERWRITE_WORD))) throw new Error('参加を取りやめました');
    } else if (prev) {
      log('');
      log('この端末は既に同じ宛先に、同じ参加用の秘密で参加しています。参加し直すと端末トークンが新しくなります。');
      if (!(await confirm('cloud.json を上書きしますか。', 'y'))) throw new Error('参加を取りやめました');
    }
  }

  // retryForbidden は渡さない。貼り間違えたトークンで 30 秒待たせない。
  const joined = await joinWorker(url, t.secret, o.device, { fetch: o.fetch ?? realFetch, sleep: o.sleep ?? realSleep, log });
  const conf: CloudConfig = {
    url,
    joinSecret: t.secret,
    deviceToken: joined.deviceToken,
    workerName: null,
    accountId: null,
    dbName: null,
    bucketName: null,
    joinedAt: Date.now(),
  };
  saveCloudConfig(o.home, conf);
  log('');
  log(`参加しました: ${url}`);
  log('hangar を再起動すると同期が始まり、他の端末の本文が ~/.agent-hangar/remote に降りてきます。');
  return conf;
}

// ---- hangar cloud status ----

/** 経過を人の読む形にする。now を注入できるようにして、テストが時計に依らないようにする。 */
const relative = (ms: number | null, now: number): string => {
  if (ms === null) return 'まだ';
  const s = Math.max(0, Math.round((now - ms) / 1000));
  return s < 60 ? `${s} 秒前` : s < 3600 ? `${Math.round(s / 60)} 分前` : `${Math.round(s / 3600)} 時間前`;
};

/** status の 1 回の問い合わせの締め切り。黒穴のような宛先で永久に待たない。 */
const STATUS_TIMEOUT_MS = 10_000;

export type CloudStatusOptions = {
  home: string;
  fetch?: typeof fetch;
  port?: number;
  now?: () => number;
};

/**
 * cloud.json、Worker の /health、手元のサーバの同期の状態を並べる。
 * 「未参加」と「壊れている」を分けて見せる。分けないと、権限の事故を参加し直しで潰しに行くことになる。
 * アカウント ID は出さない。画面共有と貼り付けで漏れる値を、見て嬉しくもないのに置かない。
 */
export async function cloudStatus(o: CloudStatusOptions): Promise<string> {
  const fetchFn = o.fetch ?? realFetch;
  const now = o.now ?? Date.now;
  const read = readCloudConfig(o.home);
  if (read.state === 'absent') return 'クラウド同期: 未設定（hangar setup cloud か hangar join を実行してください）';
  if (read.state === 'broken' || !read.config) return `クラウド同期: 設定を読めません\n${brokenConfigMessage(o.home)}`;
  const c = read.config;

  const lines: string[] = [];
  try {
    const r = await fetchFn(`${c.url}/health`, { signal: AbortSignal.timeout(STATUS_TIMEOUT_MS) });
    const j = r.ok ? ((await r.json()) as { ok?: boolean; version?: string }) : null;
    lines.push(`Worker: ${c.url}（${j?.ok ? `ok, ${j.version ?? '?'}` : `HTTP ${r.status}`}）`);
  } catch (e) {
    lines.push(`Worker: ${c.url}（接続できません: ${e instanceof Error ? e.message : String(e)}）`);
  }
  lines.push(c.workerName ? `役割: setup を実行した端末（Worker ${c.workerName}）` : '役割: 参加した端末（teardown はできません）');
  lines.push(`アカウント ID と参加用の秘密は ${cloudConfigPath(o.home)} にあります（画面に出すと漏れるので表示しません）。`);
  try {
    const token = fs.readFileSync(path.join(o.home, 'token'), 'utf8').trim();
    const r = await fetchFn(`http://127.0.0.1:${o.port ?? 4177}/api/sync/status`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(STATUS_TIMEOUT_MS) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const s = (await r.json()) as SyncStatusDto;
    const t = now();
    lines.push(
      `同期: ${s.state}${s.error ? `（${s.error}）` : ''}、未送信 ${s.pending} 件、最終 pull ${relative(s.lastPullAt, t)}、最終 push ${relative(s.lastPushAt, t)}、端末 ${s.deviceCount} 台`,
    );
  } catch {
    lines.push('同期: サーバは停止中（hangar start で起動すると同期が始まります）');
  }
  return lines.join('\n');
}

// ---- hangar cloud teardown ----

/** 他端末の本文の置き場は 0700、中身は 0600。会話の本文そのものである。 */
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

/**
 * 設定ファイルの写しの置き場。
 * 端末 ID の入れ物と混ざらないよう、ID には使えない字（先頭の _）で始める。
 */
const CONFIG_DIR = '_config';

/** 一覧を何回まで辿るか。進まない応答や、際限のない一覧で回り続けないための歯止めである。 */
const MAX_FILE_PAGES = 200;

export type RescueResult = { downloaded: number; already: number; failed: { key: string; message: string }[] };

/**
 * R2 の 1 件を手元のどこへ置くか。
 * 鍵と相対パスが同じファイルを指していることも確かめる。
 * 復号と SHA-256 は「その申告どおりのもの」しか見ないので、
 * 正しく暗号化された別のファイルへ丸ごと差し替えられたときに気付けない。
 * 判定は puller の checkKeyMatchesPath と同じ物差しにしてある。
 */
export function rescueTargetPath(home: string, e: FileEntry): string {
  if (e.kind === 'config') {
    if (!isSafeRelPath(e.path) || e.key !== configKey(e.path)) throw new Error(`設定ファイルの鍵と相対パスが食い違っています: ${e.key}`);
    return path.join(remoteRoot(home), CONFIG_DIR, ...e.path.split('/'));
  }
  const parts = path.posix.normalize(e.path).split('/');
  const suffix = parts.slice(2).join('/');
  if (parts[0] !== 'projects' || parts.length < 3 || suffix === '' || e.key !== `transcripts/${e.deviceId}/${suffix}.gz`) {
    throw new Error(`本文の鍵と相対パスが食い違っています: ${e.key}`);
  }
  return remoteTranscriptPath(home, e.deviceId, e.path);
}

/** R2 にある本文の一覧を最後まで辿る。 */
export async function listAllFiles(client: Pick<CloudClient, 'listFiles'>): Promise<FileEntry[]> {
  const out: FileEntry[] = [];
  let since = 0;
  for (let page = 0; page < MAX_FILE_PAGES; page++) {
    const r = await client.listFiles(since, PULL_LIMIT);
    out.push(...r.files);
    if (!r.more || r.nextSeq <= since) return out;
    since = r.nextSeq;
  }
  throw new Error('R2 の一覧が終わりません。もう一度実行してください');
}

/** 1 件を降ろす。復号して gzip を解き、指紋が合ったものだけを本物の名前にする。 */
async function downloadOne(client: Pick<CloudClient, 'getFile'>, e: FileEntry, target: string, key: Buffer): Promise<void> {
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: DIR_MODE });
  const tmp = `${target}.part`;
  try {
    fs.rmSync(tmp, { force: true });
    const body = await client.getFile(e.key);
    const sink = (): fs.WriteStream => fs.createWriteStream(tmp, { mode: FILE_MODE });
    // pipeline でつなぐ。裸の pipe だと復号の error が未処理になってプロセスごと落ちる。
    if (e.encrypted) await pipeline(body, decryptStream(key), createGunzip(), sink());
    else await pipeline(body, createGunzip(), sink());
    const sha = await sha256Stream(fs.createReadStream(tmp));
    if (sha !== e.sha256) throw new Error(`本文の SHA-256 が一致しません: ${e.key}`);
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
  entries: FileEntry[];
  joinSecret: string;
  client: Pick<CloudClient, 'getFile'>;
  deviceId?: string;
  claudeDir?: string;
  log?: (line: string) => void;
}): Promise<RescueResult> {
  const log = o.log ?? ((l: string) => console.log(l));
  const key = deriveFileKey(o.joinSecret);
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
      log(`降ろしました: ${e.key}`);
      r.downloaded++;
    } catch (err) {
      r.failed.push({ key: e.key, message: err instanceof Error ? err.message : String(err) });
    }
  }
  return r;
}

export type TeardownOptions = {
  home: string;
  wrangler?: WranglerRunner;
  fetch?: typeof fetch;
  confirm?: ConfirmWord;
  log?: (line: string) => void;
  cloudDir?: string;
  /** 自端末の ID。自分が上げた本文を降ろし直さないために使う。 */
  deviceId?: string;
  /** 自端末の ~/.claude。原本があるかを見るために使う。 */
  claudeDir?: string;
};

/**
 * Worker、R2、D1 を消す。setup cloud を実行した端末だけが使え、確認を 2 段で取る。
 * 消す前に、R2 にしか無い本文を手元へ降ろす。1 件でも降ろせなければ、何も消さずに止める。
 * 途中の失敗は表示して先へ進み、最後にまとめて報告する。
 */
export async function runTeardown(o: TeardownOptions): Promise<boolean> {
  const log = o.log ?? ((l: string) => console.log(l));
  const confirm = o.confirm ?? promptWord;
  const read = readCloudConfig(o.home);
  if (read.state === 'broken') throw new Error(brokenConfigMessage(o.home));
  const c = read.config;
  if (!c) throw new Error('クラウド同期は未設定です');
  if (!c.workerName || !c.dbName || !c.bucketName) {
    throw new Error('teardown は setup cloud を実行した端末でだけ使えます。参加した端末では cloud.json を消すだけにしてください');
  }

  log(`Worker ${c.workerName}、D1 ${c.dbName}、R2 ${c.bucketName} を消します。取り消せません。`);
  log('同期したメタデータと、R2 にある本文の写しはすべて失われます。');

  // 消す前に、R2 にしか無い本文を手元へ降ろす。
  const client = new HttpCloudClient({ url: c.url, token: c.deviceToken, fetch: o.fetch ?? realFetch });
  let entries: FileEntry[];
  try {
    entries = await listAllFiles(client);
  } catch (e) {
    throw new Error(`R2 にある本文の一覧を読めませんでした（${e instanceof Error ? e.message : String(e)}）。何が消えるか分からないまま消せないので、やめました`);
  }
  log(`R2 には本文が ${entries.length} 件あります。手元に写しの無いものを先に降ろします。`);
  const rescued = await rescueRemoteBodies({ home: o.home, entries, joinSecret: c.joinSecret, client, deviceId: o.deviceId, claudeDir: o.claudeDir, log });
  log(`${rescued.downloaded} 件を手元へ降ろしました（${rescued.already} 件は既に手元にあります）。`);
  if (rescued.failed.length > 0) {
    log('降ろせなかった本文:');
    for (const f of rescued.failed) log(`  ${f.key}: ${f.message}`);
    throw new Error(`${rescued.failed.length} 件を降ろせませんでした。消すと元に戻せないので、やめました。しばらく待ってからもう一度実行してください`);
  }

  if ((await confirm(`続けるには Worker の名前を入力してください（${c.workerName}）。`, c.workerName)) !== true) {
    log('中止しました');
    return false;
  }
  if ((await confirm('本当に消すなら delete と入力してください。', 'delete')) !== true) {
    log('中止しました');
    return false;
  }

  const cfg = wranglerConfigPath(o.home);
  // 設定ファイルが無ければ付けない。無いパスを --config に渡すと、どの手順も始まらずに終わる。
  const withCfg = fs.existsSync(cfg) ? ['--config', cfg] : [];
  const wr = o.wrangler ?? new WranglerRunner({ cloudDir: o.cloudDir ?? defaultCloudDir(), accountId: c.accountId, log });
  const failures: string[] = [];
  const step = async (label: string, args: string[], input?: string): Promise<void> => {
    const r = await wr.run(args, input);
    if (r.code !== 0) {
      failures.push(`${label}: ${(r.stderr || r.stdout).trim().split('\n')[0] ?? ''}`);
      log(`失敗: ${label}`);
    } else {
      log(`完了: ${label}`);
    }
  };

  // --remote を付ける。付けないと wrangler は手元の miniflare の入れ物を消して、R2 には何もしない。
  for (const e of entries) await step(`R2 object ${e.key}`, ['r2', 'object', 'delete', `${c.bucketName}/${e.key}`, '--remote', ...withCfg]);
  await step(`R2 bucket ${c.bucketName}`, ['r2', 'bucket', 'delete', c.bucketName, ...withCfg]);
  await step(`Worker ${c.workerName}`, ['delete', '--name', c.workerName, ...withCfg], 'y\n');
  await step(`D1 ${c.dbName}`, ['d1', 'delete', c.dbName, '-y', ...withCfg]);

  fs.rmSync(cloudConfigPath(o.home), { force: true });
  fs.rmSync(cfg, { force: true });
  if (failures.length > 0) {
    log('残った失敗:');
    for (const f of failures) log(`  ${f}`);
    log('残った資源は Cloudflare のダッシュボードから消してください。');
  }
  log('cloud.json を消しました。他の端末の cloud.json は手で消してください。');
  return true;
}
