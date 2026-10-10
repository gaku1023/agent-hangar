import { UPDATE_FAIL_REASONS, type UpdateFailReason } from '../store/update.ts';

/**
 * デスクトップの殻（Tauri）に頼む口。
 * 殻は頁の読み込みの前に `__TAURI_INTERNALS__` を差し込むので、有無は起動の時に決まる。
 * 頼めるのは、ログを開くこと、アプリの再起動、フォルダの選択、設定の同期の適用と世代へ戻すこと、アプリの更新（確認、進み、取得、インストール）だけである。
 * どれも殻の capability（apps/desktop/src-tauri/capabilities/remote-shell.json、remote-pick-folder.json、remote-config-apply.json、remote-update.json）で、この頁の出どころにだけ許してある。
 * 設定の同期の 2 つは、殻がネイティブの確認を出し、承諾されたときだけ `~/.claude` に書く。頁は結果の文を受け取るだけである。
 */
export type DesktopBridge = {
  openLog(): Promise<void>; restart(): Promise<void>; pickFolder(defaultPath: string | null): Promise<string | null>;
  /** 適用の指示書を適用する。引数は無く、指示書は殻が hangar の置き場から読む。 */
  applyConfigSync(): Promise<ConfigShellOutcome>;
  /** 控えの世代（yyyyMMdd-HHmmss）へ戻す。 */
  restoreConfigSync(name: string): Promise<ConfigShellOutcome>;
  /** アプリの自動更新（段 5-4）。 */
  update: UpdateBridge;
};

/**
 * 殻の updater に頼む口（src-tauri/src/updater.rs）。
 * status は動いている版と取得の進み（total は大きさが分からなければ null）を返す。取得の最中に繰り返し読む。
 * check は GitHub の Release の目録を引き、新しい版があればその版を、無ければ null を返す。
 * download は check で見つけた版を取得し、署名を確かめて殻の中に持つ。install はそれを入れて再起動する（戻らないことがある）。
 * 失敗は UpdateFailure で投げる。
 */
export type UpdateBridge = {
  status(): Promise<{ current: string; done: number; total: number | null }>;
  check(): Promise<{ version: string | null }>;
  download(): Promise<void>;
  install(): Promise<void>;
};

/** 殻の updater の失敗。reason は殻が分けた理由で、知らない形の失敗（権限で断られたなど）は other にする。 */
export class UpdateFailure extends Error {
  constructor(readonly reason: UpdateFailReason, detail?: string) { super(detail ?? reason); this.name = 'UpdateFailure'; }
}

function updateFailureOf(e: unknown): UpdateFailure {
  const kind = (e as { kind?: unknown } | null)?.kind;
  const detail = (e as { detail?: unknown } | null)?.detail;
  const reason = typeof kind === 'string' && (UPDATE_FAIL_REASONS as readonly string[]).includes(kind) ? (kind as UpdateFailReason) : 'other';
  return new UpdateFailure(reason, typeof detail === 'string' ? detail : String(e));
}

/**
 * 殻の命令の結果。message は殻が返した 1 文で、そのまま知らせに出せる。generation は控えた世代の名前。
 * 殻の返事が読めなかったときは message が null で、知らせる文は Runtime が現在の言語で引く。
 */
export type ConfigShellOutcome = { status: 'applied' | 'restored' | 'cancelled' | 'none' | 'failed' | 'busy'; message: string | null; generation: string | null };

/** 殻の命令の名前。lib.rs の #[tauri::command] と build.rs の一覧にそろえる。 */
export const DESKTOP_COMMANDS = { openLog: 'open_log', restart: 'restart_app', pickFolder: 'pick_folder', applyConfigSync: 'apply_config_sync', restoreConfigSync: 'restore_config_sync' } as const;
/** 更新の命令の名前。lib.rs の #[tauri::command] と build.rs の一覧と capabilities/remote-update.json にそろえる。 */
export const UPDATE_COMMANDS = { status: 'update_status', check: 'update_check', download: 'update_download', install: 'update_install' } as const;

const count = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);

const STATUSES: ReadonlySet<string> = new Set(['applied', 'restored', 'cancelled', 'none', 'failed', 'busy']);

/** 殻の返した値を、決まった形に直す。形が違えば失敗として扱い、頁の側で書き込んだとは言わない。 */
function outcomeOf(r: unknown): ConfigShellOutcome {
  const o = r as { status?: unknown; message?: unknown; generation?: unknown } | null;
  if (!o || typeof o.status !== 'string' || !STATUSES.has(o.status) || typeof o.message !== 'string') return { status: 'failed', message: null, generation: null };
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
    update: {
      status: async () => {
        const r = await invoke(UPDATE_COMMANDS.status) as { current?: unknown; done?: unknown; total?: unknown } | null;
        // 版が読めなければ、updater の無い殻として扱わせる（Runtime が投げたのを見て何もしない）。
        if (!r || typeof r.current !== 'string') throw new UpdateFailure('other', 'update_status returned no version');
        return { current: r.current, done: count(r.done), total: typeof r.total === 'number' && r.total > 0 ? r.total : null };
      },
      check: async () => {
        const r = await invoke(UPDATE_COMMANDS.check).catch((e: unknown) => { throw updateFailureOf(e); }) as { version?: unknown } | null;
        return { version: typeof r?.version === 'string' ? r.version : null };
      },
      download: async () => { await invoke(UPDATE_COMMANDS.download).catch((e: unknown) => { throw updateFailureOf(e); }); },
      install: async () => { await invoke(UPDATE_COMMANDS.install).catch((e: unknown) => { throw updateFailureOf(e); }); },
    },
  };
}
