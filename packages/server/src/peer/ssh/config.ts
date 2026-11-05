import fs from 'node:fs';
import path from 'node:path';

/**
 * SSH の予備の経路のつなぎ先の登録（設定「ほかの PC」）。
 *
 * PC ごと（device_id で）に、SSH のユーザー名、鍵のパス、sshd のポート、相手の hangar のポートを持つ。
 * 宛先の IP とホスト鍵の指紋は登録しない（同期の devices.status の lan_ips と ssh_host_key を毎回使う）。
 *
 * 置き場は hangar のデータの置き場の `peer-ssh.json`（0600）で、同期には載せない。
 * 鍵のパスは PC ごとに違い、別の PC から見ても意味が無いためである。
 * settings.json に入れないのは、画面へ配る設定の形（SettingsDto）と、設定の同期（hangar: の好み）に混ぜないためである。
 */

export type PeerSshEntry = {
  /** 相手の PC にログインするユーザー名。 */
  user: string;
  /** この PC の秘密鍵の絶対パス。 */
  keyPath: string;
  /** 相手の sshd のポート。 */
  sshPort: number;
  /** 相手の hangar が 127.0.0.1 で待つポート。 */
  hangarPort: number;
};

export const DEFAULT_SSH_PORT = 22;
export const DEFAULT_HANGAR_PORT = 4177;

/** 入力の誤り。どの欄かだけを返す（画面の文は T14 が i18n で持つ）。 */
export type PeerSshFieldError = 'user' | 'keyPath' | 'sshPort' | 'hangarPort';

/** device_id の形。同期の ID と同じく、URL とファイル名に入れて崩れない字だけにする。 */
export const isPeerDeviceId = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(v) && v !== '.' && v !== '..';

/**
 * ユーザー名の形。ssh の引数を崩さないよう、空白、制御文字、引用符を入れない。
 * 頭の - は ssh のオプションと読まれるので断る。Windows のドメインの形（DOMAIN\user、user@domain）は通す。
 */
const USER_RE = /^[A-Za-z0-9._@\\][A-Za-z0-9._@\\$-]{0,63}$/;

const isPort = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 65535;

/** 鍵のパス。絶対パスで、改行と引用符と NUL を含まないこと。 */
function isKeyPath(v: unknown, platform: NodeJS.Platform): v is string {
  if (typeof v !== 'string' || v.length === 0 || v.length > 1024) return false;
  if (/["\r\n\0]/.test(v)) return false;
  return platform === 'win32' ? path.win32.isAbsolute(v) && /^[A-Za-z]:[\\/]/.test(v) : path.posix.isAbsolute(v);
}

/** 画面や API から来た値を確かめる。ポートは省けば既定にする。 */
export function parsePeerSshEntry(input: unknown, platform: NodeJS.Platform = process.platform): { ok: true; entry: PeerSshEntry } | { ok: false; error: PeerSshFieldError } {
  const o = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>;
  if (typeof o.user !== 'string' || !USER_RE.test(o.user)) return { ok: false, error: 'user' };
  if (!isKeyPath(o.keyPath, platform)) return { ok: false, error: 'keyPath' };
  const sshPort = o.sshPort ?? DEFAULT_SSH_PORT;
  if (!isPort(sshPort)) return { ok: false, error: 'sshPort' };
  const hangarPort = o.hangarPort ?? DEFAULT_HANGAR_PORT;
  if (!isPort(hangarPort)) return { ok: false, error: 'hangarPort' };
  return { ok: true, entry: { user: o.user, keyPath: o.keyPath, sshPort, hangarPort } };
}

type FileShape = { v: 1; peers: Record<string, PeerSshEntry> };

/** `peer-ssh.json` の読み書き。読めない行は読み捨て、書くときは一時ファイルから置き換える。 */
export class PeerSshStore {
  private readonly file: string;

  constructor(home: string, private readonly platform: NodeJS.Platform = process.platform) {
    this.file = path.join(home, 'peer-ssh.json');
  }

  list(): Record<string, PeerSshEntry> {
    let raw: unknown;
    try { raw = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { return {}; }
    const peers = (raw as Partial<FileShape> | null)?.peers;
    if (typeof peers !== 'object' || peers === null) return {};
    const out: Record<string, PeerSshEntry> = {};
    for (const [id, v] of Object.entries(peers)) {
      if (!isPeerDeviceId(id)) continue;
      const r = parsePeerSshEntry(v, this.platform);
      if (r.ok) out[id] = r.entry;
    }
    return out;
  }

  get(deviceId: string): PeerSshEntry | null {
    return this.list()[deviceId] ?? null;
  }

  set(deviceId: string, entry: PeerSshEntry): void {
    if (!isPeerDeviceId(deviceId)) throw new Error('invalid device id');
    this.write({ ...this.list(), [deviceId]: entry });
  }

  remove(deviceId: string): boolean {
    const peers = this.list();
    if (!(deviceId in peers)) return false;
    delete peers[deviceId];
    this.write(peers);
    return true;
  }

  private write(peers: Record<string, PeerSshEntry>): void {
    const body: FileShape = { v: 1, peers };
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
}
