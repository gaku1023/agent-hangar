import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { type CloudConfig, type ConfigWriter, HttpCloudClient, Keyring, readCloudConfig, RosterStore, saveCloudConfig } from '@agent-hangar/server/src/cliEntry.ts';
import {
  decodeEpochList,
  E2eOpenError,
  encodeEpochList,
  fromBase64Url,
  generateKeyPair,
  importPrivate,
  openKeybox,
  parseRecoveryKey,
  RECOVERY_RECIPIENT,
  recoverySecretTail,
  sealKeybox,
  toBase64Url,
  type KeyboxesOut,
  type KeyPairRaw,
} from '@agent-hangar/shared';
import { bootstrapDevice, brokenConfigMessage, type DeviceLike, legacyConfigMessage, openFloorFirst, readAccounts, requireCloudDir, sha256Hex, workerFetch } from './cloud.ts';
import { DetailedError } from './probe.ts';
import { type CfAccount, isAccountId, WranglerRunner } from './wrangler.ts';

// ---- 表示と確認 ----

/** 末尾 4 文字を聞き直す回数。外れ続けたら、リカバリーキーを表示し直す。 */
export const RECOVERY_TAIL_TRIES = 3;
/** 表示し直す回数の上限。入力が閉じている（EOF）ときに聞き続けないための上限でもある。 */
export const RECOVERY_SHOW_ROUNDS = 3;

/** 保存したことを確かめられなかった。setup はリカバリーキーをクラウドに登録する前に止まる。 */
export class RecoveryKeyNotConfirmedError extends Error {
  constructor() {
    super('リカバリーキーの保存を確認できませんでした。setup はまだ完了していません（このリカバリーキーはクラウドに登録していません）。hangar setup cloud をもう一度実行すると、新しいリカバリーキーを表示します');
    this.name = 'RecoveryKeyNotConfirmedError';
  }
}

/** 端末の画面とスクロールバックを消し、カーソルを左上に戻す。 */
const CLEAR_SCREEN = '\x1b[2J\x1b[3J\x1b[H';

const normalizeTail = (s: string): string => String(s).normalize('NFKC').replace(/[\s\-]/g, '').toUpperCase();

/** 秘密を含むファイルを 0600 で書く。既にあるファイルも 0600 に直してから書く。 */
function writeSecretFile(file: string, text: string): void {
  const fd = fs.openSync(file, 'w', 0o600);
  try {
    try {
      fs.fchmodSync(fd, 0o600);
    } catch {
      // Windows では効かない。開いたときの mode に任せる。
    }
    fs.writeFileSync(fd, text);
  } finally {
    fs.closeSync(fd);
  }
}

function showText(text: string, saved: string | null): string {
  const lines = [
    '',
    'リカバリーキー（表示はこの 1 回だけです）:',
    '',
    ...text.split('\n'),
    '',
    '4 行すべてをパスワードマネージャーに保存してください。すべての PC を失ったときに、このキーで hangar recover を実行してクラウドのデータを復元します。',
    'この PC はリカバリーキーの暗号鍵を保存しないため、後から表示できません（設定の「リカバリーキーを再発行」で新しいものに差し替えることはできます）。',
    '標準出力に出力したため、ターミナルのスクロールバックにも表示されたままになります。保存したら、スクロールバックを消去するか、このターミナルのウィンドウを閉じてください。',
  ];
  if (saved) lines.push(`${saved} にも保存しました（0600）。パスワードマネージャーに保存したら、このファイルは削除してください。`);
  lines.push('');
  return lines.join('\n') + '\n';
}

/**
 * リカバリーキーを表示し、保存した暗号鍵の末尾 4 文字を入力してもらう（設計書「リカバリーキー」）。
 * saveTo があれば、表示の前にそのファイルへ 0600 で書く。askSavePath が真で saveTo が無ければ、保存先を先に尋ねる。
 * 外れたら聞き直し、RECOVERY_TAIL_TRIES 回外れたら表示し直す。RECOVERY_SHOW_ROUNDS 回表示しても合わなければ RecoveryKeyNotConfirmedError を投げる。
 * 合ったら、端末なら画面とスクロールバックを消す。
 */
export async function showAndConfirmRecoveryKey(o: { text: string; ask: (q: string) => Promise<string>; write: (s: string) => void; saveTo?: string; askSavePath?: boolean; isTTY?: boolean }): Promise<void> {
  const tail = recoverySecretTail(o.text);
  let saveTo = o.saveTo;
  if (!saveTo && o.askSavePath) {
    const a = (await o.ask('リカバリーキーをファイルにも保存する場合は、保存先のパスを入力してください（空なら保存しません）: ')).trim();
    if (a) saveTo = path.resolve(a);
  }
  if (saveTo) writeSecretFile(saveTo, `${o.text}\n`);
  for (let round = 0; round < RECOVERY_SHOW_ROUNDS; round++) {
    o.write(showText(o.text, saveTo ?? null));
    for (let i = 0; i < RECOVERY_TAIL_TRIES; i++) {
      if (normalizeTail(await o.ask('保存した暗号鍵の末尾 4 文字を入力してください: ')) === tail) {
        o.write(`${(o.isTTY ?? process.stdout.isTTY === true) ? CLEAR_SCREEN : ''}リカバリーキーの保存を確認しました。\n`);
        return;
      }
      o.write('末尾 4 文字が一致しません。保存した暗号鍵の最後の 4 文字を入力してください。\n');
    }
  }
  throw new RecoveryKeyNotConfirmedError();
}

// ---- hangar recover ----

/** 標準入力から一度に受け取る上限。リカバリーキーは 4 行で 200 字ほどである。 */
const MAX_STDIN_BYTES = 64 * 1024;

/**
 * リカバリーキーの文を標準入力から受け取る。argv に載せると ps とシェルの履歴から読めてしまう。
 * パイプなら全部を読む。端末なら、読める 4 行がそろうか、空の行が来るまで読む。
 */
export async function readRecoveryKeyInput(): Promise<string> {
  if (!process.stdin.isTTY) {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of process.stdin) {
      const b = c as Buffer;
      size += b.length;
      if (size > MAX_STDIN_BYTES) throw new Error('標準入力が長すぎます。リカバリーキーの 4 行だけを渡してください');
      chunks.push(b);
    }
    return Buffer.concat(chunks).toString('utf8');
  }
  process.stdout.write('保存したリカバリーキーの 4 行を貼り付けてください（読み取れたら次に進みます。空の行で中止します）:\n');
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  const lines: string[] = [];
  try {
    for await (const line of rl) {
      if (line.trim() === '') {
        if (lines.length > 0) break;
        continue;
      }
      lines.push(line);
      try {
        parseRecoveryKey(lines.join('\n'));
        break;
      } catch {
        // まだ行がそろっていない。
      }
      if (lines.length >= 8) break;
    }
  } finally {
    rl.close();
  }
  return lines.join('\n');
}

/**
 * recover の下書き（~/.agent-hangar/cloud-recover-pending.json、0600）。
 * bootstrap で受け取った端末トークンは、同じ端末 ID では 2 度と受け取れない。
 * cloud.json を書き終える前に止まっても（違うリカバリーキーを入れた、通信が切れた）、もう一度の recover で同じトークンから続けるために置く。
 * epochs は recovery 宛ての keybox を開けた後に入る。開けた後は、名簿か keybox を書いた時点で recovery の道が閉じるので、ここから続ける。
 */
type PendingRecover = {
  v: 1;
  url: string;
  cloudId: string;
  deviceId: string;
  deviceToken: string;
  keyPair: KeyPairRaw;
  workerName: string;
  accountId: string;
  epochs: Record<string, string> | null;
  createdAt: number;
};

export function recoverPendingPath(home: string): string {
  return path.join(home, 'cloud-recover-pending.json');
}

function writeRecoverPending(home: string, p: PendingRecover): void {
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const file = recoverPendingPath(home);
  const tmp = `${file}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`;
  try {
    writeSecretFile(tmp, JSON.stringify(p, null, 2) + '\n');
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* 元のファイルは無事である */ }
    throw e;
  }
}

function readRecoverPending(home: string): PendingRecover | null {
  try {
    const v = JSON.parse(fs.readFileSync(recoverPendingPath(home), 'utf8')) as Partial<PendingRecover>;
    const kp = v.keyPair as Partial<KeyPairRaw> | undefined;
    const str = (x: unknown): x is string => typeof x === 'string' && x !== '';
    if (v.v !== 1 || !str(v.url) || !str(v.cloudId) || !str(v.deviceId) || !str(v.deviceToken) || !str(kp?.pub) || !str(kp?.priv) || !str(v.workerName) || !str(v.accountId)) return null;
    const epochs = v.epochs && typeof v.epochs === 'object' && !Array.isArray(v.epochs) ? (v.epochs as Record<string, string>) : null;
    return { v: 1, url: v.url, cloudId: v.cloudId, deviceId: v.deviceId, deviceToken: v.deviceToken, keyPair: { pub: kp!.pub!, priv: kp!.priv! }, workerName: v.workerName, accountId: v.accountId, epochs, createdAt: typeof v.createdAt === 'number' ? v.createdAt : 0 };
  } catch {
    return null;
  }
}

/** X25519 の秘密鍵から公開鍵を求める（raw の 32 バイトの base64url）。 */
async function publicOf(priv: string): Promise<string> {
  const jwk = await globalThis.crypto.subtle.exportKey('jwk', await importPrivate(priv, true));
  const raw = fromBase64Url(String(jwk.x ?? ''));
  if (!raw || raw.length !== 32) throw new Error('リカバリーキーの公開鍵を求められませんでした');
  return toBase64Url(raw);
}

/** workers.dev の URL なら、先頭のラベルが Worker の名前である（setup cloud の --name）。 */
export function workerNameOf(url: string): string | null {
  const host = new URL(url).hostname;
  const m = /^([a-z0-9-]+)\.[a-z0-9-]+\.workers\.dev$/i.exec(host);
  return m ? m[1]!.toLowerCase() : null;
}

/** recover の先の Cloudflare のアカウント。指定があればそれを、1 つだけならそれを使う。複数あれば --account-id を求める。 */
function chooseRecoverAccount(accounts: CfAccount[], requested: { id: string; from: string } | null): CfAccount {
  const list = accounts.map((a) => `  ${a.name || '（名前なし）'}（${a.id}）`);
  if (requested) {
    const hit = isAccountId(requested.id) ? accounts.find((a) => a.id === requested.id.toLowerCase()) : undefined;
    if (hit) return hit;
    throw new DetailedError([`${requested.from} のアカウント（${requested.id}）は、現在のログインで使えるアカウントにありません。`, '現在のログインで使えるアカウント:', ...list].join('\n'));
  }
  if (accounts.length === 1) return accounts[0]!;
  if (accounts.length === 0) throw new Error('このログインで使える Cloudflare のアカウントがありません。wrangler whoami の出力を確認してください');
  throw new DetailedError([`このログインでは Cloudflare のアカウントが ${accounts.length} 個あります。Worker を作成したアカウントを --account-id <ID> か環境変数 CLOUDFLARE_ACCOUNT_ID で指定して、もう一度実行してください。`, ...list].join('\n'));
}

export type RecoverOptions = {
  home: string;
  device: DeviceLike;
  /** 保存したリカバリーキーの 4 行。 */
  text: string;
  /** Worker の名前。既定は workers.dev の URL の先頭のラベル。 */
  name?: string;
  /** --account-id。Worker を作成した Cloudflare のアカウント ID。 */
  accountId?: string;
  /** CLOUDFLARE_ACCOUNT_ID を読む先。既定は process.env。 */
  env?: NodeJS.ProcessEnv;
  wrangler?: WranglerRunner;
  cloudDir?: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
  now?: () => number;
};

export type RecoverResult = { url: string; epochs: number[] };

const LOST_KEY = 'このリカバリーキーではクラウドの暗号鍵を復号できません。再発行して古くなったリカバリーキーか、別のクラウドのリカバリーキーです。最後に保存したリカバリーキーで、もう一度実行してください';
const MISMATCH_KEY = 'このリカバリーキーは、クラウドに登録されているリカバリーキーと一致しません。再発行して古くなったリカバリーキーの可能性があります。最後に保存したリカバリーキーで、もう一度実行してください';

/**
 * すべての PC を失ったときに、リカバリーキーで新しい PC をクラウド同期に戻す（設計書「リカバリーキー」の使い方）。
 *
 * 端末トークンは Cloudflare アカウントの所有で取り直す。新しいトークンのハッシュを `wrangler secret put BOOTSTRAP_TOKEN_HASH` で入れ、`POST /bootstrap` で登録する。
 * bootstrap の直後の端末だけが、recovery 宛ての keybox を読める（`GET /keyboxes?recipient=recovery`）。
 * それをリカバリーキーの秘密鍵で開いて世代 1 から n の鍵を得て、名簿の recoveryPub がこのリカバリーキーの公開鍵であることを確かめる。
 * 違えば（再発行の後の古いリカバリーキーなど）何も書かずに断る。
 * 合えば、この PC の鍵ペアで自分宛ての keybox を置き、名簿に自分を足し、cloud.json（版 2）を書く。
 * 登録した端末 ID は home の device.id で、keybox の AAD にもこの ID が入る。
 */
export async function runRecover(o: RecoverOptions): Promise<RecoverResult> {
  const log = o.log ?? ((l: string) => console.log(l));
  const fetchFn = o.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = o.now ?? Date.now;

  // 1. リカバリーキーと cloud.json。どちらかで断るときは、Worker にも wrangler にも触らない。
  const key = parseRecoveryKey(o.text);
  const url = new URL(key.url.trim().replace(/\/+$/, '')).origin;
  const read = readCloudConfig(o.home);
  if (read.state === 'broken') throw new Error(brokenConfigMessage(o.home));
  if (read.state === 'legacy') throw new DetailedError(legacyConfigMessage(o.home));
  if (read.config) throw new Error(`この PC はすでにクラウド同期に参加しています（${read.config.url}）。hangar recover は、どのクラウドにも参加していない PC で実行してください`);
  const recoveryPub = await publicOf(key.priv);

  const floor = openFloorFirst(o.home, 'Cloudflare にはまだ何も変更していません', 'hangar recover');
  try {
    // 2. 端末トークン。下書きに同じクラウドの分があれば、それで続ける（同じ端末 ID は 2 度 bootstrap できない）。
    let pending = readRecoverPending(o.home);
    if (pending && (pending.url !== url || pending.deviceId !== o.device.id)) pending = null;
    if (!pending) {
      const workerName = o.name?.trim() || workerNameOf(url);
      if (!workerName) throw new Error(`${url} から Worker の名前を読み取れません。--name <Worker の名前> を指定して、もう一度実行してください`);
      const h = await workerFetch(url, '/health', { fetch: fetchFn });
      const health = h.ok ? ((await h.json().catch(() => null)) as { cloudId?: unknown } | null) : null;
      const cloudId = typeof health?.cloudId === 'string' ? health.cloudId : '';
      if (cloudId === '') throw new Error(`${url}/health が正常に応答しません（HTTP ${h.status}）。リカバリーキーの URL と Worker の状態を確認してください`);

      let wr = o.wrangler ?? new WranglerRunner({ cloudDir: o.cloudDir ?? requireCloudDir(), accountId: null, log });
      let who = await readAccounts(wr);
      if (!who.loggedIn) {
        log('Cloudflare にログインします。ブラウザが開きます。');
        if ((await wr.runInteractive(['login'])) !== 0) throw new Error('wrangler login に失敗しました');
        who = await readAccounts(wr);
        if (!who.loggedIn) throw new Error('アカウントを読み取れませんでした。wrangler whoami の出力を確認してください');
      }
      const envAccount = (o.env ?? process.env).CLOUDFLARE_ACCOUNT_ID?.trim();
      const requested = o.accountId !== undefined ? { id: o.accountId.trim(), from: '--account-id' } : envAccount ? { id: envAccount, from: 'CLOUDFLARE_ACCOUNT_ID' } : null;
      const account = chooseRecoverAccount(who.accounts, requested);
      wr = wr.withAccount(account.id);

      const token = randomBytes(32).toString('base64url');
      const put = await wr.run(['secret', 'put', 'BOOTSTRAP_TOKEN_HASH', '--name', workerName], sha256Hex(token) + '\n');
      if (put.code !== 0) throw new Error(`Worker ${workerName} に最初の端末トークンを登録できませんでした（wrangler secret put の終了コード ${put.code}）。--name と --account-id が Worker を作成したときと同じかを確認してください`);
      const keyPair = await generateKeyPair();
      await bootstrapDevice(url, token, o.device.id, { fetch: fetchFn, sleep, log });
      pending = { v: 1, url, cloudId, deviceId: o.device.id, deviceToken: token, keyPair, workerName, accountId: account.id, epochs: null, createdAt: now() };
      writeRecoverPending(o.home, pending);
    }
    const client = new HttpCloudClient({ url, token: pending.deviceToken, fetch: fetchFn });

    // 3. recovery 宛ての keybox を開く。
    if (!pending.epochs) {
      const r = await workerFetch(url, `/keyboxes?recipient=${RECOVERY_RECIPIENT}`, { fetch: fetchFn, token: pending.deviceToken });
      if (!r.ok) throw new Error(`リカバリーキーの暗号鍵をクラウドから受信できませんでした（HTTP ${r.status}）`);
      const { boxes } = (await r.json()) as KeyboxesOut;
      const box = boxes.reduce<(typeof boxes)[number] | null>((a, b) => (a === null || b.epoch > a.epoch ? b : a), null);
      if (!box) throw new Error('クラウドにリカバリーキーの暗号鍵がありません。hangar setup cloud が最後まで完了していない可能性があります');
      let epochs: Record<string, string>;
      try {
        const sealed = fromBase64Url(box.sealed);
        if (!sealed) throw new E2eOpenError();
        epochs = decodeEpochList(await openKeybox(await importPrivate(key.priv), recoveryPub, { epoch: box.epoch, recipient: RECOVERY_RECIPIENT }, sealed)).epochs;
      } catch {
        throw new Error(LOST_KEY);
      }
      if (Object.keys(epochs).length === 0) throw new Error(LOST_KEY);
      pending = { ...pending, epochs };
      writeRecoverPending(o.home, pending);
    }
    const epochs = pending.epochs!;
    const numbers = Object.keys(epochs).map(Number).sort((a, b) => a - b);
    const currentEpoch = numbers.at(-1)!;

    // 4. 名簿を開き、recoveryPub を照合する。違えば何も書かない。
    let conf: CloudConfig = {
      v: 2,
      url,
      cloudId: pending.cloudId,
      deviceToken: pending.deviceToken,
      keyPair: pending.keyPair,
      epochs,
      currentEpoch,
      phoneKey: null,
      rosterVersion: 0,
      workerName: pending.workerName,
      accountId: pending.accountId,
      // setup cloud は D1 を Worker と同じ名前、R2 を <名前>-files で作る。
      dbName: pending.workerName,
      bucketName: `${pending.workerName}-files`,
      joinedAt: now(),
    };
    const writer: ConfigWriter = { read: () => conf, write: (p) => { conf = { ...conf, ...p }; } };
    const keyring = await Keyring.fromConfig(conf);
    const roster = new RosterStore(client, keyring, writer, o.device.id);
    let current;
    try {
      current = await roster.read();
    } catch (e) {
      if (e instanceof E2eOpenError) throw new Error(LOST_KEY);
      throw e;
    }
    if (current.version === 0) throw new Error('クラウドに PC の一覧がありません。hangar setup cloud が最後まで完了していない可能性があります');
    if (current.roster.recoveryPub !== recoveryPub) throw new Error(MISMATCH_KEY);

    // 5. 自分宛ての keybox を置き、名簿に自分を足す。
    const content = encodeEpochList({ epochs });
    await client.putKeyboxes([{ epoch: currentEpoch, recipient: o.device.id, sealed: toBase64Url(await sealKeybox(pending.keyPair.pub, { epoch: currentEpoch, recipient: o.device.id }, content)) }]);
    const entry = { id: o.device.id, kind: 'pc' as const, name: o.device.name, os: o.device.platform, pub: pending.keyPair.pub, joinedAt: conf.joinedAt };
    const done = await roster.update((r) => ({ ...r, entries: [...r.entries.filter((e) => e.id !== o.device.id), entry] }));

    // 6. cloud.json を書き、本文を上げ始める床を同じ時点で刻む。
    conf = { ...conf, rosterVersion: done.version, phoneKey: done.roster.phoneKey };
    saveCloudConfig(o.home, conf);
    floor.stamp(conf.joinedAt);
    fs.rmSync(recoverPendingPath(o.home), { force: true });
    log(`クラウド同期に戻りました: ${url}`);
    log('hangar を再起動すると同期が始まります。すべてのデータを受信するまで、しばらくかかります。');
    log('使ったリカバリーキーは引き続き使えます。漏れた可能性があるときは、設定の「リカバリーキーを再発行」で差し替えてください。');
    return { url, epochs: numbers };
  } finally {
    floor.close();
  }
}
