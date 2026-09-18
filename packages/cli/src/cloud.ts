import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { type CloudConfig, readCloudConfig, saveCloudConfig } from '@agent-hangar/server';
import { encodeJoinToken, type JoinResponse } from '@agent-hangar/shared';
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
  if (read.state === 'broken') {
    throw new Error(
      `${path.join(o.home, 'cloud.json')} を読めません（壊れているか、権限の事故です）。参加し直すと別の参加用の秘密が入り、R2 にある既存の暗号化ファイルを復号できなくなります。ファイルを直すか控えから戻してから、もう一度実行してください。`,
    );
  }
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
