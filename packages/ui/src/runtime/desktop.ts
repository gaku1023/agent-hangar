import type { SetupTarget } from '@agent-hangar/shared';
import type { CloudDeviceOut } from '@agent-hangar/shared';
import type { CloudFailure, JoinPlanView } from '../store/cloudMember.ts';
import { UPDATE_FAIL_REASONS, type UpdateFailReason } from '../store/update.ts';

/**
 * デスクトップの殻（Tauri）に頼む口。
 * 殻は頁の読み込みの前に `__TAURI_INTERNALS__` を差し込むので、有無は起動の時に決まる。
 * 頼めるのは、ログを開くこと、アプリの再起動、フォルダの選択、設定の同期の適用と世代へ戻すこと、アプリの更新（確認、進み、取得、インストール）、
 * クラウド同期への参加と PC の解除とこの PC の参加の解除（remote-cloud.json）だけである。
 * どれも殻の capability（apps/desktop/src-tauri/capabilities/remote-shell.json、remote-pick-folder.json、remote-config-apply.json、remote-update.json）で、この頁の出どころにだけ許してある。
 * 設定の同期の 2 つと連携の書き込みは、殻が自分の承諾の窓（サーバを通らない頁）で書く中身を見せ、承諾されたときだけ CLI が書く。頁は結果を受け取るだけで、承諾を出すことはできない。
 */
export type DesktopBridge = {
  openLog(): Promise<void>; restart(): Promise<void>; pickFolder(defaultPath: string | null): Promise<string | null>;
  /** 適用の指示書を適用する。引数は無く、指示書は殻が hangar の置き場から読む。 */
  applyConfigSync(): Promise<ConfigShellOutcome>;
  /** 控えの世代（yyyyMMdd-HHmmss）へ戻す。 */
  restoreConfigSync(name: string): Promise<ConfigShellOutcome>;
  /** 連携を書き込む（MCP、シェル連携、ステータスライン）。殻が見立てを承諾の窓に見せ、承諾されたときだけ CLI が書く。 */
  setupIntegration(target: SetupTarget): Promise<SetupShellOutcome>;
  /** アプリの自動更新（段 5-4）。 */
  update: UpdateBridge;
  /** クラウド同期への参加と、PC の解除と、この PC の参加の解除（0.4.0）。殻は必ず持つ。試験の偽物は省ける。 */
  cloud?: CloudBridge;
};

/** 殻のクラウド同期の命令の答え。失敗は符号（CLI の code か、殻の cannot-start、timeout など）と文で返す。 */
export type CloudReply<T> = { ok: true; value: T } | { ok: false; failure: CloudFailure };

/**
 * 殻のクラウド同期の命令（src-tauri/src/cloudmember.rs）。殻は同梱の CLI を --json で走らせ、最後の 1 行の JSON を返す。
 * 参加トークンはサーバの HTTP API に載せず、ここから殻へ渡す（殻は CLI の標準入力へ渡す）。
 */
export type CloudBridge = {
  joinPlan(token: string): Promise<CloudReply<JoinPlanView>>;
  join(token: string, overwrite: boolean): Promise<CloudReply<{ url: string; host: string }>>;
  revoke(id: string): Promise<CloudReply<CloudDeviceOut>>;
  leave(revoke: boolean): Promise<CloudReply<{ revoked: boolean; revokeError: string | null; creator: boolean }>>;
};

/** クラウド同期の命令の名前。lib.rs の #[tauri::command] と build.rs の一覧と capabilities/remote-cloud.json にそろえる。 */
export const CLOUD_COMMANDS = { joinPlan: 'cloud_join_plan', join: 'cloud_join', revoke: 'cloud_revoke', leave: 'cloud_leave' } as const;

/** 殻の答えを決まった形に直す。成功は key の中身が物であるときだけで、形が違えば unreadable の失敗にする。 */
function cloudReplyOf<T>(r: unknown, key: 'plan' | 'result'): CloudReply<T> {
  const o = r as { ok?: unknown; code?: unknown; message?: unknown; plan?: unknown; result?: unknown } | null;
  if (o && o.ok === true && o[key] && typeof o[key] === 'object') return { ok: true, value: o[key] as T };
  if (o && o.ok === false && typeof o.code === 'string') return { ok: false, failure: { code: o.code, message: typeof o.message === 'string' ? o.message : '' } };
  return { ok: false, failure: { code: 'unreadable', message: '' } };
}

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

/**
 * 連携の書き込みの結果。written は書いた、none はもう済んでいた、cancelled は承諾の窓で取り消した（書けずに閉じたときは failed）。
 * code は理由の鍵（already、absent、windows、no-script、changed など）で、画面が文を選ぶ。message は殻の文（CLI の文は日本語だけ）。
 */
export type SetupShellOutcome = { status: 'written' | 'none' | 'cancelled' | 'failed' | 'busy'; message: string | null; code: string | null };

/** 殻の命令の名前。lib.rs の #[tauri::command] と build.rs の一覧にそろえる。 */
export const DESKTOP_COMMANDS = { openLog: 'open_log', restart: 'restart_app', pickFolder: 'pick_folder', applyConfigSync: 'apply_config_sync', restoreConfigSync: 'restore_config_sync', setupIntegration: 'setup_integration' } as const;

const SETUP_STATUSES: ReadonlySet<string> = new Set(['written', 'none', 'cancelled', 'failed', 'busy']);

/** 殻の返した値を、決まった形に直す。形が違えば失敗として扱い、書いたとは言わない。 */
function setupOutcomeOf(r: unknown): SetupShellOutcome {
  const o = r as { status?: unknown; message?: unknown; code?: unknown } | null;
  if (!o || typeof o.status !== 'string' || !SETUP_STATUSES.has(o.status)) return { status: 'failed', message: null, code: null };
  return { status: o.status as SetupShellOutcome['status'], message: typeof o.message === 'string' ? o.message : null, code: typeof o.code === 'string' ? o.code : null };
}
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

const shellFailure = (e: unknown): { ok: false; failure: CloudFailure } => ({ ok: false, failure: { code: 'shell', message: String(e) } });

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
    setupIntegration: async (target) => setupOutcomeOf(await invoke(DESKTOP_COMMANDS.setupIntegration, { target })),
    cloud: {
      // 権限で断られたなど、殻が投げた失敗も、答えの形に直して返す（画面は段を閉じずに理由を出す）。
      joinPlan: (token) => invoke(CLOUD_COMMANDS.joinPlan, { token }).then((r) => cloudReplyOf<JoinPlanView>(r, 'plan'), shellFailure),
      join: (token, overwrite) => invoke(CLOUD_COMMANDS.join, { token, overwrite }).then((r) => cloudReplyOf<{ url: string; host: string }>(r, 'result'), shellFailure),
      revoke: (id) => invoke(CLOUD_COMMANDS.revoke, { id }).then((r) => cloudReplyOf<CloudDeviceOut>(r, 'result'), shellFailure),
      leave: (revoke) => invoke(CLOUD_COMMANDS.leave, { revoke }).then((r) => cloudReplyOf<{ revoked: boolean; revokeError: string | null; creator: boolean }>(r, 'result'), shellFailure),
    },
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
