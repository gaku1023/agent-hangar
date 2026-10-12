import type { PermissionAskDto } from '@agent-hangar/shared';

/**
 * hangar が起こした claude の hook から届く、道具の許可の確認（PermissionRequest）。
 *
 * 許可待ちになったことは登録（status が waiting、waitingFor が permission prompt）でわかるが、何の許可かは登録に無い。
 * 道具の名前と入力は、この hook の tool_name と tool_input にだけある（2026-10-12 に 2.1.296 で確かめた）。
 * Notification の hook は約 6 秒遅れて決まった文言しか運ばないので使わない。
 * hook は裏（async）で走らせ、何も出力しない。許可するかどうかには口を出さない。
 */
export type PermissionHook = { providerSessionId: string; ask: PermissionAskDto };

/** 命令の全文の上限。現在の札は折り返して全文を出すが、極端に長いものは切る。 */
const INPUT_MAX = 2000;
const DESCRIPTION_MAX = 300;

const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);

/** 入力の中から、許可の中身として見せる 1 つを選ぶ。命令、ファイル、URL、パス、検索の語の順。知らない形は空にする。 */
function inputOf(input: unknown): string {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return '';
  const i = input as Record<string, unknown>;
  return (text(i.command) ?? text(i.file_path) ?? text(i.notebook_path) ?? text(i.url) ?? text(i.path) ?? text(i.pattern) ?? text(i.query) ?? '').slice(0, INPUT_MAX);
}

function descriptionOf(input: unknown): string | null {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return null;
  return text((input as Record<string, unknown>).description)?.replace(/\s+/g, ' ').slice(0, DESCRIPTION_MAX) ?? null;
}

/**
 * hook の入力（JSON を読んだもの）から、許可の確認を読む。
 * サブエージェントの確認（agent_id がある）も読む。確認は同じ端末に出て、利用者が答えるのは同じだからである。
 * ほかの出来事と、欠けた値は null にする。入口に届く値は claude が書いたもので、形を信じない。
 */
export function readPermissionHook(body: unknown): PermissionHook | null {
  if (typeof body !== 'object' || body === null) return null;
  const b = body as Record<string, unknown>;
  if (b.hook_event_name !== 'PermissionRequest') return null;
  const providerSessionId = text(b.session_id);
  const tool = text(b.tool_name);
  if (providerSessionId === null || tool === null) return null;
  return { providerSessionId, ask: { tool, input: inputOf(b.tool_input), description: descriptionOf(b.tool_input) } };
}
