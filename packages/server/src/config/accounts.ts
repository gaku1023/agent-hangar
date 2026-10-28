import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { newId, PRIMARY_ACCOUNT_ID } from '@agent-hangar/shared';
import { MessageError, msg, type Message } from '../i18n/message.ts';

/** 最初のアカウント（既定の置き場）の id。消せない。定義は shared にある（画面も使う）。 */
export { PRIMARY_ACCOUNT_ID };
/** 色の候補。追加のたびに、まだ使っていないものを前から選ぶ。 */
export const ACCOUNT_COLORS = ['#2a57b8', '#7a4a9e', '#2b7048', '#c77a1a', '#a2452f'] as const;
const NAME_MAX = 40;
const COLOR = /^#[0-9a-f]{6}$/;

export type Account = { id: string; name: string; dir: string; color: string };
type FileShape = { currentId: string; primary: { name: string; color: string }; accounts: Account[] };

export class AccountError extends MessageError {
  constructor(readonly status: 400 | 404, text: Message | string) { super(text); }
}

const isAccount = (v: unknown): v is Account => {
  if (typeof v !== 'object' || v === null) return false;
  const a = v as Record<string, unknown>;
  return typeof a.id === 'string' && a.id !== PRIMARY_ACCOUNT_ID && typeof a.name === 'string' && typeof a.dir === 'string' && path.isAbsolute(a.dir) && typeof a.color === 'string';
};

/**
 * Claude Code のアカウントの一覧と、いまのアカウント。
 * この PC の中だけの設定なので、hangar.db（同期する）ではなく <home>/accounts.json に持つ。
 * 認証の中身は持たない。持つのは名前、置き場、色だけである。
 */
export class AccountStore {
  private state: FileShape;
  private readonly file: string;
  private readonly homeDir: string;
  private readonly prefix: string;

  /** file は <home> の下の保存先、dirPrefix は足す置き場の名前の接頭辞（Claude は .claude-、Codex は .codex-）。 */
  constructor(private readonly o: { home: string; primaryDir: string; homeDir?: string; file?: string; dirPrefix?: string }) {
    this.file = path.join(o.home, o.file ?? 'accounts.json');
    this.prefix = o.dirPrefix ?? '.claude-';
    this.homeDir = o.homeDir ?? os.homedir();
    this.state = this.load();
  }

  /** 読めないファイルや形の違う項目は捨て、最初のアカウントだけの状態に落とす。サーバの起動は止めない。 */
  private load(): FileShape {
    const empty: FileShape = { currentId: PRIMARY_ACCOUNT_ID, primary: { name: 'メイン', color: ACCOUNT_COLORS[0] }, accounts: [] };
    let raw: unknown;
    try { raw = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { return empty; }
    if (typeof raw !== 'object' || raw === null) return empty;
    const r = raw as Record<string, unknown>;
    const accounts = Array.isArray(r.accounts) ? r.accounts.filter(isAccount) : [];
    const p = (typeof r.primary === 'object' && r.primary !== null ? r.primary : {}) as Record<string, unknown>;
    const primary = { name: typeof p.name === 'string' && p.name.trim() ? p.name : empty.primary.name, color: typeof p.color === 'string' && COLOR.test(p.color) ? p.color : empty.primary.color };
    const currentId = typeof r.currentId === 'string' && (r.currentId === PRIMARY_ACCOUNT_ID || accounts.some((a) => a.id === r.currentId)) ? r.currentId : PRIMARY_ACCOUNT_ID;
    return { currentId, primary, accounts };
  }

  private save(): void {
    fs.writeFileSync(this.file, JSON.stringify(this.state, null, 2) + '\n', { mode: 0o600 });
    fs.chmodSync(this.file, 0o600);
  }

  primary(): Account { return { id: PRIMARY_ACCOUNT_ID, name: this.state.primary.name, dir: this.o.primaryDir, color: this.state.primary.color }; }
  list(): Account[] { return [this.primary(), ...this.state.accounts.map((a) => ({ ...a }))]; }
  get(id: string): Account | null { return this.list().find((a) => a.id === id) ?? null; }
  current(): Account { return this.get(this.state.currentId) ?? this.primary(); }

  private must(id: string): Account {
    const a = this.get(id);
    if (!a) throw new AccountError(404, msg('account.error.notFound'));
    return a;
  }

  setCurrent(id: string): void {
    this.must(id);
    this.state.currentId = id;
    this.save();
  }

  private cleanName(name: string, exceptId?: string): string {
    const n = name.trim();
    if (!n) throw new AccountError(400, msg('account.name.required'));
    if ([...n].length > NAME_MAX) throw new AccountError(400, msg('account.name.tooLong', { max: NAME_MAX }));
    if (this.list().some((a) => a.id !== exceptId && a.name === n)) throw new AccountError(400, msg('account.name.duplicate', { name: n }));
    return n;
  }

  /** まだ無い ~/.claude-N（N は 2 から）を返す。置き場そのものは作らない。作るのはリンクを張る側である。 */
  private nextDir(): string {
    for (let n = 2; ; n++) {
      const dir = path.join(this.homeDir, `${this.prefix}${n}`);
      if (!fs.existsSync(dir) && !this.byDir(dir)) return dir;
    }
  }

  /**
   * 名前から、足すアカウントの場所の候補を作る。~/.claude-<名前> で、名前は英小文字と数字だけにし、ほかの文字の並びは - に寄せる。
   * 英数字が残らない名前（日本語の名前など）は、空いている連番（~/.claude-2 から）にする。
   * 登録済みの場所なら後ろに -2、-3 と付ける。登録していない既存のフォルダはそのまま返す（中身は足す前の確かめで見せる）。
   * 場所そのものは作らない。
   */
  suggestDir(name: string): string {
    const slug = name.normalize('NFKC').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, NAME_MAX);
    if (slug === '') return this.nextDir();
    const base = path.join(this.homeDir, `${this.prefix}${slug}`);
    if (!this.byDir(base)) return base;
    for (let n = 2; ; n++) {
      const dir = `${base}-${n}`;
      if (!this.byDir(dir)) return dir;
    }
  }

  /** 画面で打った場所を絶対パスにする。前後の空白を落とし、~ と ~/（Windows は ~\ も）はホームから読む。相対パスと空は断る。 */
  resolveDir(input: string): string {
    const v = input.trim();
    const abs = v === '~' ? this.homeDir : /^~[\\/]/.test(v) ? path.join(this.homeDir, v.slice(2)) : v;
    if (!path.isAbsolute(abs)) throw new AccountError(400, msg('account.dir.mustBeAbsolute'));
    return path.resolve(abs);
  }

  byDir(dir: string): Account | null {
    const want = path.resolve(dir);
    return this.list().find((a) => path.resolve(a.dir) === want) ?? null;
  }

  add(input: { name: string; dir?: string }): Account {
    const name = this.cleanName(input.name);
    let dir: string;
    if (input.dir === undefined) dir = this.nextDir();
    else {
      if (!path.isAbsolute(input.dir)) throw new AccountError(400, msg('account.dir.mustBeAbsolute'));
      dir = path.resolve(input.dir);
      if (this.byDir(dir)) throw new AccountError(400, msg('account.dir.alreadyRegistered', { dir }));
    }
    const used = new Set(this.list().map((a) => a.color));
    const color = ACCOUNT_COLORS.find((c) => !used.has(c)) ?? ACCOUNT_COLORS[this.list().length % ACCOUNT_COLORS.length]!;
    const account: Account = { id: newId(), name, dir, color };
    this.state.accounts.push(account);
    this.save();
    return { ...account };
  }

  update(id: string, patch: { name?: string; color?: string }): Account {
    const cur = this.must(id);
    const name = patch.name === undefined ? cur.name : this.cleanName(patch.name, id);
    const color = patch.color === undefined ? cur.color : patch.color;
    if (!COLOR.test(color)) throw new AccountError(400, msg('account.color.invalid'));
    if (id === PRIMARY_ACCOUNT_ID) this.state.primary = { name, color };
    else this.state.accounts = this.state.accounts.map((a) => (a.id === id ? { ...a, name, color } : a));
    this.save();
    return this.must(id);
  }

  /** 登録だけを外す。置き場のディレクトリと、その中のログインは残す。 */
  remove(id: string): void {
    if (id === PRIMARY_ACCOUNT_ID) throw new AccountError(400, msg('account.error.primaryNotRemovable'));
    this.must(id);
    this.state.accounts = this.state.accounts.filter((a) => a.id !== id);
    if (this.state.currentId === id) this.state.currentId = PRIMARY_ACCOUNT_ID;
    this.save();
  }
}
