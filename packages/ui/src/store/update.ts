/**
 * アプリの自動更新の状態（段 5-4）。
 * 更新は「知らせて、押して入れる」で、勝手には入れない。
 * 確認、取得、インストールは殻（Tauri の updater）が行い、ここはその結果を受けて状態を移すだけの純関数である。
 * Runtime が殻を呼び（runtime/updater.ts）、結果をこの reduceUpdate に通して Store に置く。
 * 右下の札（presenters/update.ts）と設定の「更新」の節が、同じ状態から描く。
 */

/** 失敗の理由。殻が updater の誤りを 4 つに分けて返す（src-tauri/src/updater.rs の failure_kind）。 */
export type UpdateFailReason = 'network' | 'signature' | 'permission' | 'other';
export const UPDATE_FAIL_REASONS: readonly UpdateFailReason[] = ['network', 'signature', 'permission', 'other'];

/**
 * 更新の段階。
 * unknown はまだ確認していない、latest は新しい版が無い、available は新しい版がある、downloading は取得中、ready は取得が済んで再起動を待っている、installing はインストールの最中である。
 * failed の step は、どこで失敗したか。確認の失敗は版を持たない。
 */
export type UpdatePhase =
  | { kind: 'unknown' } | { kind: 'checking' } | { kind: 'latest' }
  | { kind: 'available'; version: string }
  | { kind: 'downloading'; version: string; done: number; total: number | null }
  | { kind: 'ready'; version: string }
  | { kind: 'installing'; version: string }
  | { kind: 'failed'; step: 'check' | 'download' | 'install'; version: string | null; reason: UpdateFailReason };

/**
 * supported は殻が updater を持つか（ブラウザでは偽）。current は動いている版。
 * checkedAt は最後に確認が済んだ時刻、manual は最後の確認が手動（設定の「更新を確認」）だったか。
 * notify は新しい版を知らせるか（設定のスイッチ）。切ると自動の確認もしない。手動の確認は常に使える。
 * dismissed は札を閉じた版。同じ版の札は 2 度出さない。端末ごとに localStorage に残す。
 */
export type UpdateState = {
  supported: boolean; current: string | null; phase: UpdatePhase; checkedAt: number | null; manual: boolean;
  notify: boolean; dismissed: string | null;
};

export type UpdateEvent =
  | { type: 'supported'; current: string }
  | { type: 'restore'; dismissed: unknown; notify: unknown }
  | { type: 'check.start'; manual: boolean }
  | { type: 'check.done'; version: string | null; at: number }
  | { type: 'check.failed'; reason: UpdateFailReason }
  | { type: 'download.start' }
  | { type: 'download.progress'; done: number; total: number | null }
  | { type: 'download.done' }
  | { type: 'download.failed'; reason: UpdateFailReason }
  | { type: 'install.start' }
  | { type: 'install.failed'; reason: UpdateFailReason }
  | { type: 'dismiss' }
  | { type: 'notify'; on: boolean };

export function initialUpdate(): UpdateState {
  return { supported: false, current: null, phase: { kind: 'unknown' }, checkedAt: null, manual: false, notify: true, dismissed: null };
}

/** その段階が指す版。版の無い段階では null。 */
export function phaseVersion(p: UpdatePhase): string | null {
  switch (p.kind) {
    case 'available': case 'downloading': case 'ready': case 'installing': return p.version;
    case 'failed': return p.version;
    default: return null;
  }
}

/** 取得からインストールまでの途中か。そのあいだは確認をし直さない（見つけた版を差し替えない）。 */
export function updateBusy(p: UpdatePhase): boolean {
  return p.kind === 'downloading' || p.kind === 'ready' || p.kind === 'installing';
}

export function reduceUpdate(s: UpdateState, e: UpdateEvent): UpdateState {
  const p = s.phase;
  switch (e.type) {
    case 'supported': return { ...s, supported: true, current: e.current };
    case 'restore':
      return { ...s, dismissed: typeof e.dismissed === 'string' ? e.dismissed : null, notify: typeof e.notify === 'boolean' ? e.notify : true };
    case 'check.start':
      if (updateBusy(p)) return s;
      return { ...s, phase: { kind: 'checking' }, manual: e.manual };
    case 'check.done':
      return { ...s, phase: e.version === null ? { kind: 'latest' } : { kind: 'available', version: e.version }, checkedAt: e.at };
    case 'check.failed':
      return { ...s, phase: { kind: 'failed', step: 'check', version: null, reason: e.reason } };
    case 'download.start': {
      // 見つけた版があるとき（新しい版あり、取得かインストールの失敗）だけ取りに行ける。
      const ok = p.kind === 'available' || (p.kind === 'failed' && p.step !== 'check' && p.version !== null);
      const version = phaseVersion(p);
      if (!ok || version === null) return s;
      // 閉じた版を自分で取りに行ったなら、その版の札をまた出す。
      return { ...s, phase: { kind: 'downloading', version, done: 0, total: null }, dismissed: s.dismissed === version ? null : s.dismissed };
    }
    case 'download.progress':
      return p.kind === 'downloading' ? { ...s, phase: { ...p, done: e.done, total: e.total } } : s;
    case 'download.done':
      return p.kind === 'downloading' ? { ...s, phase: { kind: 'ready', version: p.version } } : s;
    case 'download.failed':
      return p.kind === 'downloading' ? { ...s, phase: { kind: 'failed', step: 'download', version: p.version, reason: e.reason } } : s;
    case 'install.start':
      return p.kind === 'ready' ? { ...s, phase: { kind: 'installing', version: p.version } } : s;
    case 'install.failed':
      return p.kind === 'installing' ? { ...s, phase: { kind: 'failed', step: 'install', version: p.version, reason: e.reason } } : s;
    case 'dismiss': {
      const version = phaseVersion(p);
      return version === null || version === s.dismissed ? s : { ...s, dismissed: version };
    }
    case 'notify': return s.notify === e.on ? s : { ...s, notify: e.on };
  }
}

/**
 * 右下の札に出す段階。出さないときは null。
 * 新しい版の知らせは、知らせを入れているか、手動で確認したときだけ出す。
 * 取得してからの段階（取得中、準備完了、インストール中、その失敗）は、利用者が押して始めたものなので知らせのスイッチに依らず出す。
 * どれも、閉じた版なら出さない。確認の失敗は札にしない（設定の節にだけ出す）。
 */
export function cardPhase(s: UpdateState): UpdatePhase | null {
  if (!s.supported) return null;
  const p = s.phase;
  const version = phaseVersion(p);
  if (version === null || version === s.dismissed) return null;
  if (p.kind === 'available') return s.notify || s.manual ? p : null;
  return p;
}
