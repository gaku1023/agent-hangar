/**
 * デスクトップの殻（Tauri）に頼む口。
 * 殻は頁の読み込みの前に `__TAURI_INTERNALS__` を差し込むので、有無は起動の時に決まる。
 * 頼めるのは、ログを開くこと、アプリの再起動、フォルダの選択、設定の同期の適用と世代へ戻すことだけである。
 * どれも殻の capability（apps/desktop/src-tauri/capabilities/remote-shell.json、remote-pick-folder.json、remote-config-apply.json）で、この頁の出どころにだけ許してある。
 * 設定の同期の 2 つは、殻がネイティブの確認を出し、承諾されたときだけ `~/.claude` に書く。頁は結果の文を受け取るだけである。
 */
export type DesktopBridge = {
  openLog(): Promise<void>; restart(): Promise<void>; pickFolder(defaultPath: string | null): Promise<string | null>;
  /** 適用の指示書を適用する。引数は無く、指示書は殻が hangar の置き場から読む。 */
  applyConfigSync(): Promise<ConfigShellOutcome>;
  /** 控えの世代（yyyyMMdd-HHmmss）へ戻す。 */
  restoreConfigSync(name: string): Promise<ConfigShellOutcome>;
};

/** 殻の命令の結果。message は日本語の 1 文で、そのまま知らせに出せる。generation は控えた世代の名前。 */
export type ConfigShellOutcome = { status: 'applied' | 'restored' | 'cancelled' | 'none' | 'failed' | 'busy'; message: string; generation: string | null };

/** 殻の命令の名前。lib.rs の #[tauri::command] と build.rs の一覧にそろえる。 */
export const DESKTOP_COMMANDS = { openLog: 'open_log', restart: 'restart_app', pickFolder: 'pick_folder', applyConfigSync: 'apply_config_sync', restoreConfigSync: 'restore_config_sync' } as const;

const STATUSES: ReadonlySet<string> = new Set(['applied', 'restored', 'cancelled', 'none', 'failed', 'busy']);

/** 殻の返した値を、決まった形に直す。形が違えば失敗として扱い、頁の側で書き込んだとは言わない。 */
function outcomeOf(r: unknown): ConfigShellOutcome {
  const o = r as { status?: unknown; message?: unknown; generation?: unknown } | null;
  if (!o || typeof o.status !== 'string' || !STATUSES.has(o.status) || typeof o.message !== 'string') return { status: 'failed', message: '殻の返事を読めませんでした。', generation: null };
  return { status: o.status as ConfigShellOutcome['status'], message: o.message, generation: typeof o.generation === 'string' ? o.generation : null };
}

type TauriInternals = { invoke(cmd: string, args?: Record<string, unknown>): Promise<unknown> };

/** 殻の中なら口を返し、ブラウザなら null を返す。 */
export function createDesktopBridge(win: unknown): DesktopBridge | null {
  const internals = (win as { __TAURI_INTERNALS__?: Partial<TauriInternals> } | null)?.__TAURI_INTERNALS__;
  if (!internals || typeof internals.invoke !== 'function') return null;
  const invoke = internals.invoke.bind(internals);
  return {
    openLog: async () => { await invoke(DESKTOP_COMMANDS.openLog); },
    restart: async () => { await invoke(DESKTOP_COMMANDS.restart); },
    // 取り消したら殻は null を返す。文字列でなければ取り消しと同じに扱う。
    pickFolder: async (defaultPath) => { const r = await invoke(DESKTOP_COMMANDS.pickFolder, { defaultPath }); return typeof r === 'string' ? r : null; },
    applyConfigSync: async () => outcomeOf(await invoke(DESKTOP_COMMANDS.applyConfigSync)),
    restoreConfigSync: async (name) => outcomeOf(await invoke(DESKTOP_COMMANDS.restoreConfigSync, { name })),
  };
}
