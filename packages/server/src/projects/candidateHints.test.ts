import { describe, expect, it } from 'vitest';
import { candidateNotes, cloudSyncedOf, type CloudSyncEnv } from './candidateHints.ts';

// 会話したフォルダの候補に添える注記（セットアップのすゝめが読む）。
// どちらも純粋な判定で、ファイルシステムの問い合わせは差し替える。

const MAC_HOME = '/Users/taro';
const MOBILE = `${MAC_HOME}/Library/Mobile Documents`;
const mac = (over: Partial<CloudSyncEnv> = {}): CloudSyncEnv => ({ platform: 'darwin', homeDir: MAC_HOME, env: {}, exists: () => false, realpath: (p) => p, ...over });

const WIN_HOME = 'C:\\Users\\Taro';
const win = (over: Partial<CloudSyncEnv> = {}): CloudSyncEnv => ({ platform: 'win32', homeDir: WIN_HOME, env: {}, exists: () => false, realpath: (p) => p, ...over });

describe('cloudSyncedOf（クラウドで同期しているフォルダか）', () => {
  it('macOS の iCloud Drive（~/Library/Mobile Documents の下）は icloud', () => {
    expect(cloudSyncedOf(`${MOBILE}/com~apple~CloudDocs/notes`, mac())).toBe('icloud');
    expect(cloudSyncedOf(`${MOBILE}/iCloud~md~obsidian/Documents/vault`, mac())).toBe('icloud');
  });
  it('macOS のデスクトップと書類は、iCloud Drive にその実体があるときだけ icloud', () => {
    const synced = (p: string) => p === `${MOBILE}/com~apple~CloudDocs/Desktop` || p === `${MOBILE}/com~apple~CloudDocs/Documents`;
    expect(cloudSyncedOf(`${MAC_HOME}/Desktop/app`, mac({ exists: synced }))).toBe('icloud');
    expect(cloudSyncedOf(`${MAC_HOME}/Documents/a/b`, mac({ exists: synced }))).toBe('icloud');
    expect(cloudSyncedOf(`${MAC_HOME}/Desktop/app`, mac())).toBeNull();
    // デスクトップと書類のほかは、実体があっても数えない。
    expect(cloudSyncedOf(`${MAC_HOME}/src/app`, mac({ exists: () => true }))).toBeNull();
  });
  it('macOS で実体のパス（realpath）が iCloud Drive の下なら icloud', () => {
    const real = (p: string) => (p === `${MAC_HOME}/work` ? `${MOBILE}/com~apple~CloudDocs/work` : p);
    expect(cloudSyncedOf(`${MAC_HOME}/work`, mac({ realpath: real }))).toBe('icloud');
    expect(cloudSyncedOf(`${MAC_HOME}/other`, mac({ realpath: real }))).toBeNull();
    // 実体を引けないときは、パスのまま見る。
    expect(cloudSyncedOf(`${MAC_HOME}/other`, mac({ realpath: () => null }))).toBeNull();
  });
  it('Windows は環境変数 OneDrive、OneDriveConsumer、OneDriveCommercial の下を onedrive にする。区切りと大文字小文字は問わない', () => {
    expect(cloudSyncedOf('c:/users/taro/onedrive/Documents/app', win({ env: { OneDrive: 'C:\\Users\\Taro\\OneDrive' } }))).toBe('onedrive');
    expect(cloudSyncedOf('C:\\Users\\Taro\\OneDrive - Contoso\\proj', win({ env: { OneDriveCommercial: 'C:\\Users\\Taro\\OneDrive - Contoso\\' } }))).toBe('onedrive');
    expect(cloudSyncedOf('D:\\Sync\\x', win({ env: { OneDriveConsumer: 'd:\\sync' } }))).toBe('onedrive');
    expect(cloudSyncedOf('D:\\Other\\x', win({ env: { OneDriveConsumer: 'd:\\sync' } }))).toBeNull();
  });
  it('Windows は環境変数が無くても、ホームの直下の OneDrive の名前のフォルダ（既知のフォルダの移動先）の下を onedrive にする', () => {
    expect(cloudSyncedOf('C:\\Users\\Taro\\OneDrive\\Desktop\\app', win())).toBe('onedrive');
    expect(cloudSyncedOf('c:\\users\\taro\\onedrive - contoso\\documents\\app', win())).toBe('onedrive');
    expect(cloudSyncedOf('C:\\Users\\Taro\\src\\OneDrive\\app', win())).toBeNull();
    expect(cloudSyncedOf('C:\\Users\\Taro\\OneDriveTools', win())).toBeNull();
    expect(cloudSyncedOf('C:\\Users\\Taro\\src\\app', win())).toBeNull();
  });
  it('macOS の判定も、ホームの形に合った区切りでパスを組む（Windows の試験機で macOS の判定を試しても同じ答えになる）', () => {
    const home = 'D:\\a\\home';
    const synced = (p: string) => p === 'D:\\a\\home\\Library\\Mobile Documents\\com~apple~CloudDocs\\Desktop';
    expect(cloudSyncedOf('D:\\a\\home\\Desktop\\thing', mac({ homeDir: home, exists: synced }))).toBe('icloud');
    expect(cloudSyncedOf('D:\\a\\home\\Library\\Mobile Documents\\x', mac({ homeDir: home }))).toBe('icloud');
    expect(cloudSyncedOf('D:\\a\\home\\src\\thing', mac({ homeDir: home, exists: () => true }))).toBeNull();
  });
  it('Linux では判定しない', () => {
    expect(cloudSyncedOf('/home/taro/Documents/x', { ...mac(), platform: 'linux', homeDir: '/home/taro', exists: () => true })).toBeNull();
  });
});

describe('candidateNotes（候補の注記の符号）', () => {
  const DAY = 24 * 60 * 60 * 1000;
  const NOW = 100 * DAY;
  const c = (p: string, over: Partial<{ sessionCount: number; lastActivityAt: number | null; isGit: boolean }> = {}) => ({ path: p, sessionCount: 2, lastActivityAt: NOW - DAY, isGit: true, ...over });
  const notes = (x: ReturnType<typeof c>, homeDir = MAC_HOME) => candidateNotes(x, { homeDir, now: NOW });

  it('デスクトップとダウンロードの直下（そのものも含む）に注記を付ける。もっと深いものには付けない', () => {
    expect(notes(c(`${MAC_HOME}/Desktop/app`))).toEqual(['desktop-direct']);
    expect(notes(c(`${MAC_HOME}/Desktop`))).toEqual(['desktop-direct']);
    expect(notes(c(`${MAC_HOME}/Desktop/a/b`))).toEqual([]);
    expect(notes(c(`${MAC_HOME}/Downloads/unzipped`))).toEqual(['downloads-direct']);
    expect(notes(c(`${MAC_HOME}/src/Desktop`))).toEqual([]);
  });
  it('Windows のパスは区切りと大文字小文字を問わずに比べる', () => {
    expect(notes(c('c:\\users\\taro\\desktop\\app'), WIN_HOME)).toEqual(['desktop-direct']);
    expect(notes(c('C:/Users/Taro/Downloads/x'), WIN_HOME)).toEqual(['downloads-direct']);
    expect(notes(c('C:\\Users\\Taro\\src\\x'), WIN_HOME)).toEqual([]);
  });
  it('git でない、最後の活動が 30 日より前、会話が 1 件だけ、を符号で返す', () => {
    expect(notes(c(`${MAC_HOME}/x`, { isGit: false }))).toEqual(['not-git']);
    expect(notes(c(`${MAC_HOME}/x`, { lastActivityAt: NOW - 31 * DAY }))).toEqual(['stale-30d']);
    expect(notes(c(`${MAC_HOME}/x`, { lastActivityAt: NOW - 29 * DAY }))).toEqual([]);
    expect(notes(c(`${MAC_HOME}/x`, { sessionCount: 1 }))).toEqual(['single-session']);
    expect(notes(c(`${MAC_HOME}/Desktop/x`, { isGit: false, lastActivityAt: NOW - 40 * DAY, sessionCount: 1 }))).toEqual(['desktop-direct', 'not-git', 'stale-30d', 'single-session']);
  });
  it('最後の活動が分からないものは古いとしない', () => {
    expect(notes(c(`${MAC_HOME}/x`, { lastActivityAt: null }))).toEqual([]);
  });
});
