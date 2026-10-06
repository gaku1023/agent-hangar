/**
 * デスクトップの殻（Tauri）に頼む口。
 * 殻は頁の読み込みの前に `__TAURI_INTERNALS__` を差し込むので、有無は起動の時に決まる。
 * 頼めるのは、ログを開くこと、アプリの再起動、フォルダの選択の 3 つだけである。
 * どれも殻の capability（apps/desktop/src-tauri/capabilities/remote-shell.json と remote-pick-folder.json）で、この頁の出どころにだけ許してある。
 */
export type DesktopBridge = { openLog(): Promise<void>; restart(): Promise<void>; pickFolder(defaultPath: string | null): Promise<string | null> };

/** 殻の命令の名前。lib.rs の #[tauri::command] と build.rs の一覧にそろえる。 */
export const DESKTOP_COMMANDS = { openLog: 'open_log', restart: 'restart_app', pickFolder: 'pick_folder' } as const;

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
  };
}
