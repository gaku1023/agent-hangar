import type { TOOL_NAMES } from './tools.ts';

/**
 * MCP の道具の棚卸し（#547）。hangar の外のエージェントにも、プロンプトインジェクションされたエージェントにも届く口なので、道具ごとに何ができるかと、外に出してよい理由を残す。
 * 道具を足したら、ここにも足す。足し忘れは型と toolClasses.test.ts が止める。
 *
 * - irreversible：取り消せない、または利用者の手で戻す必要がある。利用者の承認を挟む。
 * - stop：動いているものを止める。止めても会話は残り、再開できる。
 * - launch：会話を起こす、再開する。増えるだけで、何も失わない。
 * - drive：別の会話へ入力を渡す。
 * - outward：hangar の外へ出す。
 * - write：hangar の中の記録を書く。
 * - read：読むだけ。
 */
export type ToolKind = 'irreversible' | 'stop' | 'launch' | 'drive' | 'outward' | 'write' | 'read';
export type ToolClass = { kind: ToolKind; why: string };

export const TOOL_CLASSES: Record<(typeof TOOL_NAMES)[number], ToolClass> = {
  list_projects: { kind: 'read', why: "Reads a list only. A per-session URL narrows it to that project." },
  get_project: { kind: 'read', why: "Reads one project only." },
  list_sessions: { kind: 'read', why: "Reads session briefs only." },
  search_sessions: { kind: 'read', why: "Reads past sessions, which is what this surface is for." },
  get_transcript: { kind: 'read', why: "Reads only, and never passes thinking." },
  get_usage: { kind: 'read', why: "Reads usage only, with no credentials." },
  open_in_hangar: { kind: 'read', why: "Returns a link and does not move the screen." },
  read_session_screen: { kind: 'read', why: "Reads another session's screen only." },
  update_project: { kind: 'write', why: "TODOs stay proposals. Only the user marks them done." },
  set_session_summary: { kind: 'write', why: "Writes the summary of the session itself." },
  set_turn_intent: { kind: 'write', why: "Writes the intent of the session itself." },
  propose_session_status: { kind: 'write', why: "Sets a status tag. Nothing is lost and the screen can change it." },
  notify_user: { kind: 'write', why: "Only notifies, through the targets the user chose." },
  set_notify_preference: { kind: 'write', why: "Writes how to notify, which the settings screen can change." },
  create_session: { kind: 'launch', why: "Adds a session and loses nothing." },
  resume_session: { kind: 'launch', why: "Continues a stopped session." },
  send_to_session: { kind: 'drive', why: "Needed to orchestrate sessions. The input runs within the permissions of the receiving session." },
  stop_session: { kind: 'stop', why: "The session stays and can be resumed. The user decided no approval is needed." },
  draft_issue_report: { kind: 'write', why: "Writes a draft and sends nothing." },
  submit_issue_report: { kind: 'outward', why: "Posts a public issue. The full text is shown to the user first, and private data is masked by machine." },
  delete_session: { kind: 'irreversible', why: "Deletes a session. The tool only files a request. hangar deletes after the user approves on the screen (sessions/deleteApprovals.ts)." },
};

/** 利用者の承認を挟む道具。 */
export function toolsNeedingApproval(): string[] {
  return Object.entries(TOOL_CLASSES).filter(([, c]) => c.kind === 'irreversible').map(([n]) => n);
}
