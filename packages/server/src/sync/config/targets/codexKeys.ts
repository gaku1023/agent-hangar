/**
 * Codex の config.toml の鍵の仕分け（設計書 3 章）。
 * 鍵の名前は codex-rs の config.schema.json（確かめた版 0.164.0、トップレベル 103 鍵）から写した。値は写していない。
 * 表に無い鍵は「知らない鍵」で、運ばない。
 *
 * 項目の単位は、トップレベルの鍵、または表の 1 段下の鍵（`tui.theme`）。
 * プラグインだけは `plugins.<id>.enabled` の 3 段で、その下の他の鍵は Codex が書く状態なので運ばない。
 * `mcp_servers` は別の対象の持ち分（`codex:mcp:`）なので、ここでは読み飛ばす。
 */

import { isDatetimeValue, parseToml } from '../edit/tomlParse.ts';

export type KeyClass = 'carry' | 'machine' | 'state';

/** 表の 1 段下の仕分け。open は、表の鍵の名前が決まっていない表（機能の旗など）。 */
type Table = { sub: Readonly<Record<string, KeyClass>>; open?: 'boolean' | 'any' };

const carry = (...names: string[]): Record<string, KeyClass> => Object.fromEntries(names.map((n) => [n, 'carry' as const]));

const TOP_CARRY = [
  'model', 'model_reasoning_effort', 'model_reasoning_summary', 'model_verbosity', 'plan_mode_reasoning_effort', 'review_model', 'service_tier', 'personality',
  'model_auto_compact_token_limit', 'model_auto_compact_token_limit_scope', 'model_post_turn_compact_threshold_percent', 'model_context_window', 'compact_prompt',
  'tool_output_token_limit', 'oss_provider', 'approval_policy', 'approvals_reviewer', 'sandbox_mode', 'default_permissions', 'allow_login_shell',
  'developer_instructions', 'instructions', 'include_apps_instructions', 'include_collaboration_mode_instructions', 'include_environment_context',
  'include_environment_context_time', 'include_permissions_instructions', 'project_doc_max_bytes', 'project_doc_fallback_filenames', 'project_root_markers',
  'hide_agent_reasoning', 'show_raw_agent_reasoning', 'disable_paste_burst', 'file_opener', 'web_search', 'check_for_update_on_startup',
  'suppress_unstable_features_warning', 'background_terminal_max_timeout', 'thread_unload_delay_secs', 'experimental_use_unified_exec_tool', 'daybreak',
  'mcp_optional_startup_grace_ms',
];

/** パス、接続先、組織、認証、この PC の事情に依る鍵。運ばない。 */
const TOP_MACHINE = [
  'notify', 'projects', 'marketplaces', 'model_providers', 'shell_environment_policy', 'permissions', 'allow_symlinked_codex_home', 'log_dir', 'sqlite_home',
  'model_catalog_json', 'model_instructions_file', 'experimental_compact_prompt_file', 'model_provider', 'openai_base_url', 'chatgpt_base_url',
  'mcp_oauth_callback_port', 'mcp_oauth_callback_url', 'forced_chatgpt_workspace_id', 'forced_login_method', 'cli_auth_credentials_store',
  'mcp_oauth_credentials_store', 'mcp_enterprise_managed_auth', 'apps_mcp_product_sku', 'experimental_thread_store', 'otel', 'cloud', 'orchestrator',
  'responses_api_metadata', 'experimental_realtime_start_instructions', 'experimental_realtime_webrtc_call_base_url', 'experimental_realtime_ws_backend_prompt',
  'experimental_realtime_ws_base_url', 'experimental_realtime_ws_model', 'experimental_realtime_ws_startup_context',
];

/** Codex が実行中に書く状態。運ばず、画面にも出さない。 */
const TOP_STATE = ['notice', 'profile', 'profiles'];

const HOOK_EVENTS = ['Interrupt', 'PermissionRequest', 'PostCompact', 'PostModelRequest', 'PostToolUse', 'PreCompact', 'PreModelRequest', 'PreToolUse', 'SessionEnd', 'SessionStart', 'Stop', 'SubagentStart', 'SubagentStop', 'UserPromptSubmit'];

const TABLES: Readonly<Record<string, Table>> = {
  tui: { sub: { ...carry(
    'agents_overview_grouping', 'alternate_screen', 'animations', 'auto_recap', 'copy_on_select', 'copy_on_select_clear_selection', 'disable_paste_burst', 'effects',
    'fullscreen_transcript', 'keymap', 'mouse_scroll_speed', 'notification_condition', 'notification_method', 'notifications', 'pet', 'pet_anchor', 'presets',
    'question_esc_back', 'raw_output_mode', 'rendering', 'resume_cwd', 'right_click_paste', 'session_picker_view', 'show_server_version_notice', 'show_tooltips',
    'status_line', 'status_line_use_colors', 'terminal_resize_reflow_max_rows', 'terminal_title', 'theme', 'vim_mode_default',
  ), model_availability_nux: 'state', screen_reader_detection_done: 'state' } },
  features: { sub: {}, open: 'boolean' },
  memories: { sub: carry('consolidation_model', 'dedicated_tools', 'disable_on_external_context', 'dual_write', 'extract_model', 'generate_memories', 'max_raw_memories_for_consolidation', 'max_rollout_age_days', 'max_rollouts_per_startup', 'max_unused_days', 'min_rate_limit_remaining_percent', 'min_rollout_idle_hours', 'use_memories', 'version') },
  desktop: { sub: {}, open: 'any' },
  apps: { sub: {}, open: 'any' },
  agents: { sub: carry('default_subagent_model', 'default_subagent_reasoning_effort', 'enabled', 'interrupt_message', 'max_concurrent_threads_per_session', 'max_depth') },
  goals: { sub: carry('max_goal_token_budget') },
  analytics: { sub: carry('enabled') },
  feedback: { sub: carry('enabled') },
  history: { sub: carry('max_bytes', 'persistence') },
  ghost_snapshot: { sub: carry('disable_warnings', 'ignore_large_untracked_dirs', 'ignore_large_untracked_files') },
  windows: { sub: carry('allow_mxc', 'sandbox') },
  tools: { sub: carry('experimental_request_user_input', 'update_plan', 'web_search') },
  auto_review: { sub: carry('circuit_break_action', 'conversation_history_max_output_tokens', 'experimental_conversation_history_prompt', 'experimental_policy_template', 'extra_policy', 'policy') },
  browser_use: { sub: carry('allow_history_access', 'default_origin_policy', 'origins') },
  computer_use: { sub: carry('default_app_access', 'macos', 'windows') },
  realtime: { sub: carry('transport', 'type', 'version', 'voice') },
  audio: { sub: { microphone: 'machine', microphone_channel: 'machine', speaker: 'machine' } },
  skills: { sub: { ...carry('bundled', 'include_instructions', 'max_context_tokens'), config: 'machine' } },
  sandbox_workspace_write: { sub: { ...carry('exclude_slash_tmp', 'exclude_tmpdir_env_var', 'network_access'), writable_roots: 'machine' } },
  tool_suggest: { sub: carry('disabled_tools', 'discoverables') },
  hooks: { sub: { ...carry(...HOOK_EVENTS), state: 'state' } },
};

const TOP: Readonly<Record<string, KeyClass | 'table' | 'plugins' | 'skip'>> = {
  ...Object.fromEntries(TOP_CARRY.map((k) => [k, 'carry' as const])),
  ...Object.fromEntries(TOP_MACHINE.map((k) => [k, 'machine' as const])),
  ...Object.fromEntries(TOP_STATE.map((k) => [k, 'state' as const])),
  ...Object.fromEntries(Object.keys(TABLES).map((k) => [k, 'table' as const])),
  plugins: 'plugins',
  mcp_servers: 'skip',
};

/** 他の PC から届いたとき承諾が要る鍵の先頭（SPEC 4 章）。権限を広げうる鍵と、実行に関わる鍵。 */
const APPROVAL_TOP = new Set(['approval_policy', 'approvals_reviewer', 'sandbox_mode', 'default_permissions', 'sandbox_workspace_write', 'hooks', 'plugins']);

const isTableValue = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** 絶対パスらしい文字列（`/x`、`~/x`、`C:\x`、`C:/x`）を、値の中のどこかに持つか。1 行の文字列だけを見る。 */
export function hasAbsolutePath(v: unknown): boolean {
  if (typeof v === 'string') return !v.includes('\n') && /^(?:~[\\/]|\/[^\s/]|[A-Za-z]:[\\/]|\\\\[^\\])/.test(v.trim());
  if (Array.isArray(v)) return v.some(hasAbsolutePath);
  if (isTableValue(v)) return Object.values(v).some(hasAbsolutePath);
  return false;
}

/** この鍵の道が、運ぶ項目の単位か。受け取る側（parseId）も同じ物差しを使う。 */
export function isCarriedPath(path: readonly string[]): boolean {
  const top = TOP[path[0] ?? ''];
  if (top === undefined) return false;
  if (path.length === 1) return top === 'carry';
  if (top === 'plugins') return path.length === 3 && path[2] === 'enabled' && path[1] !== '';
  if (top !== 'table' || path.length !== 2) return false;
  const t = TABLES[path[0]!]!;
  return t.sub[path[1]!] === 'carry' || (t.open !== undefined && path[1] !== '' && !(path[1]! in t.sub));
}

/** 値がその鍵の型に合うか（外から来た値の検査）。features は真偽、plugins の enabled も真偽。 */
export function valueFitsPath(path: readonly string[], v: unknown): boolean {
  if (v === null || v === undefined) return false;
  if (path[0] === 'features' || path[0] === 'plugins') return typeof v === 'boolean';
  return true;
}

export function needsApprovalPath(path: readonly string[]): boolean {
  return APPROVAL_TOP.has(path[0] ?? '');
}

export type Walked = {
  /** 運ぶ項目。 */
  carry: { path: string[]; value: unknown }[];
  /** 運ばない鍵と理由（machine は PC の事情、path は絶対パスを値に持つ）。状態の鍵は載せない。 */
  dropped: { path: string[]; reason: 'machine' | 'path' }[];
  /** 表に無い鍵。 */
  unknown: string[][];
};

/** config.toml を読んだ木を、運ぶ・運ばない・状態・知らない、に仕分ける。 */
export function walkCodexConfig(tree: Record<string, unknown>, isScalarOk: (v: unknown) => boolean): Walked {
  const out: Walked = { carry: [], dropped: [], unknown: [] };
  const take = (path: string[], v: unknown): void => {
    if (!isScalarOk(v) || !valueFitsPath(path, v)) out.unknown.push(path);
    else if (hasAbsolutePath(v)) out.dropped.push({ path, reason: 'path' });
    else out.carry.push({ path, value: v });
  };
  for (const [k, v] of Object.entries(tree)) {
    const cls = TOP[k];
    if (cls === undefined) { out.unknown.push([k]); continue; }
    if (cls === 'state' || cls === 'skip') continue;
    if (cls === 'machine') { out.dropped.push({ path: [k], reason: 'machine' }); continue; }
    if (cls === 'carry') { take([k], v); continue; }
    if (!isTableValue(v)) { out.unknown.push([k]); continue; }
    if (cls === 'plugins') {
      for (const [id, p] of Object.entries(v)) {
        if (isTableValue(p) && 'enabled' in p) take([k, id, 'enabled'], p['enabled']);
      }
      continue;
    }
    const t = TABLES[k]!;
    for (const [k2, v2] of Object.entries(v)) {
      const c2 = t.sub[k2];
      if (c2 === 'state') continue;
      if (c2 === 'machine') { out.dropped.push({ path: [k, k2], reason: 'machine' }); continue; }
      if (c2 === 'carry' || t.open) take([k, k2], v2);
      else out.unknown.push([k, k2]);
    }
  }
  return out;
}

/** JSON にできない値（日時、安全な整数の外の整数）の目印。 */
const NOT_JSON = Symbol('not-json');

/** TOML の値を、運ぶ形（JSON）にする。できないものは NOT_JSON。整数が安全な範囲の外なら運ばない（JSON の数は 53 ビットまで）。 */
function toJson(v: unknown): unknown {
  if (typeof v === 'bigint') return v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : NOT_JSON;
  if (typeof v === 'string' || typeof v === 'boolean' || typeof v === 'number') return v;
  if (Array.isArray(v)) { const a = v.map(toJson); return a.includes(NOT_JSON) ? NOT_JSON : a; }
  if (isTableValue(v) && !isDatetimeValue(v)) {
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) { const j = toJson(x); if (j === NOT_JSON) return NOT_JSON; o[k] = j; }
    return o;
  }
  return NOT_JSON;
}

export type CodexConfigSort = {
  /** 運ぶ項目。value は JSON にした値。 */
  carry: { path: string[]; value: unknown }[];
  dropped: Walked['dropped'];
  unknown: string[][];
};

/** TOML の文字列を仕分ける。TOML として読めなければ投げる（呼ぶ側が「塞ぐ」にする）。 */
export function sortCodexToml(src: string): CodexConfigSort {
  const w = walkCodexConfig(parseToml(src).tree, (v) => toJson(v) !== NOT_JSON);
  return { carry: w.carry.map((c) => ({ path: c.path, value: toJson(c.value) })), dropped: w.dropped, unknown: w.unknown };
}

/** `<名前>.config.toml` を丸ごと運んでよいか。読めない、運ばない鍵がある、知らない鍵がある、のどれかなら false。 */
export function profileIsClean(content: Buffer): boolean {
  try {
    const s = sortCodexToml(content.toString('utf8'));
    return s.dropped.length === 0 && s.unknown.length === 0;
  } catch { return false; }
}
