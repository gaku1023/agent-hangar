import { SCHEDULE_MIN_EVERY_MINUTES } from '@agent-hangar/shared';
import { AGENT_KINDS } from '@agent-hangar/shared';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { tokenEquals, tokenFromRequest } from '../auth/request.ts';
import type { AskSource } from '../agent/types.ts';
import { VERSION } from '../boot/options.ts';
import { defaultLanguage } from '../i18n/language.ts';
import { errorText, translatorOf } from '../i18n/message.ts';
import { mcpSecretMatches } from '../runs/secrets.ts';
import { applyPermissionHook } from '../sessions/permissionAsks.ts';
import { applyQuestionHook } from '../sessions/questionHook.ts';
import { openTargetCommand } from '../platform/browser.ts';
import { execFile } from '../external/open.ts';
import { realReportDeps } from '../report/real.ts';
import { ReportService } from '../report/service.ts';
import { MAX_SCREEN_LINES, MAX_SEND_CHARS } from './screenTools.ts';
import { callTool,type ToolContext, type ToolDeps } from './tools.ts';
import { DEFAULT_WAIT_SECONDS, MAX_WAIT_SECONDS, WAIT_PROGRESS_MS } from './waitTool.ts';

/**
 * MCP の入口が受け付ける Origin。
 * auth/request.ts の一覧とは別にする。開発用の 5173 は MCP に要らないためである。
 * ポートは決め打ちにせず、実際に待ち受けているものから組み立てる。
 */
export function mcpAllowedOrigins(port: number): string[] {
  return [`http://127.0.0.1:${port}`, `http://localhost:${port}`, 'tauri://localhost'];
}

/** 説明文に「agent-hangar」を含める。Claude Code はツール定義を遅延して読むので、検索で当たる語が要る。 */
const D = (s: string) => `agent-hangar: ${s}`;
const STATUS = z.enum(['active', 'paused', 'done', 'archived']);
const STATE = z.enum(['in_progress', 'done', 'blocked', 'abandoned']);

export function buildMcpServer(deps: ToolDeps, ctx: ToolContext): McpServer {
  const server = new McpServer({ name: 'agent-hangar', version: VERSION });
  // 道具の説明と、失敗の文は、いまの言語で出す。サーバは要求ごとに作るので、設定を変えれば次の要求から変わる。
  const language = deps.language ?? defaultLanguage;
  const tr = translatorOf(language);
  const reg = (name: string, description: string, inputSchema: Record<string, z.ZodTypeAny>) => {
    server.registerTool(name, { description, inputSchema }, async (args: Record<string, unknown>, extra) => {
      // 長く待つ間は進みを流す。Claude Code は応答も進みも 300 秒無い呼び出しを切る（2.1.316 で実測）。進みの札は呼び手が付けたときだけ送れる。
      const token = extra._meta?.progressToken;
      let progress = 0;
      const beat = name === 'wait_for_session' && token !== undefined
        ? setInterval(() => { void extra.sendNotification({ method: 'notifications/progress', params: { progressToken: token, progress: ++progress } }).catch(() => undefined); }, deps.waitProgressMs ?? WAIT_PROGRESS_MS)
        : null;
      try {
        return { content: [{ type: 'text' as const, text: JSON.stringify(await callTool(deps, ctx, name, args), null, 2) }] };
      } catch (e) {
        return { content: [{ type: 'text' as const, text: errorText(language(), e) }], isError: true };
      } finally {
        if (beat) clearInterval(beat);
      }
    });
  };
  reg('list_projects', D(tr('mcp.tool.listProjects')), {});
  reg('get_project', D(tr('mcp.tool.getProject')), { project_id: z.string() });
  reg('update_project', D(tr('mcp.tool.updateProject')), { project_id: z.string(), status: STATUS.optional(), add_todos: z.array(z.union([z.string(), z.object({ text: z.string(), note: z.string().optional() })])).optional(), toggle_todos: z.array(z.string()).optional(), propose_done: z.array(z.object({ todo_id: z.string(), note: z.string() })).optional(), append_memo: z.string().optional() });
  reg('list_sessions', D(tr('mcp.tool.listSessions')), { project_id: z.string().optional(), running: z.boolean().optional(), limit: z.number().int().positive().optional() });
  reg('search_sessions', D(tr('mcp.tool.searchSessions')), { query: z.string(), project_id: z.string().optional(), since: z.number().optional(), until: z.number().optional(), file: z.string().optional(), limit: z.number().int().positive().optional() });
  reg('get_transcript', D(tr('mcp.tool.getTranscript')), { session_id: z.string().optional(), from_seq: z.number().int().optional(), limit: z.number().int().positive().optional(), include_tools: z.boolean().optional() });
  reg('create_session', D(tr('mcp.tool.createSession')), { project_id: z.string(), name: z.string().optional(), prompt: z.string().optional(), model: z.string().optional().describe(tr('mcp.createSession.modelParam')), effort: z.string().optional(), permission_mode: z.string().optional().describe(tr('mcp.createSession.permissionModeParam')), scratch: z.boolean().optional(), agent: z.enum(AGENT_KINDS).optional().describe(tr('mcp.createSession.agentParam')), mode: z.string().optional().describe(tr('mcp.createSession.modeParam')), handoff: z.boolean().optional().describe(tr('mcp.createSession.handoffParam')), worktree: z.string().optional().describe(tr('mcp.createSession.worktreeParam')), add_dirs: z.array(z.string()).optional().describe(tr('mcp.createSession.addDirsParam')), account: z.string().optional().describe(tr('mcp.createSession.accountParam')) });
  reg('set_session_summary', D(tr('mcp.tool.setSessionSummary')), { session_id: z.string().optional(), title: z.string(), one_liner: z.string(), body: z.string(), state: STATE, next_steps: z.array(z.string()) });
  reg('set_turn_intent', D(tr('mcp.tool.setTurnIntent')), { session_id: z.string().optional(), text: z.string(), to: z.array(z.string()).optional() });
  reg('notify_user', D(tr('mcp.tool.notifyUser')), { session_id: z.string().optional(), text: z.string(), kind: z.string().optional().describe(tr('mcp.notify.kindParam')), to: z.array(z.string()).optional() });
  // 必須の欠けは SDK の型の失敗でなく、tools.ts の断りの文で返すため、いずれも任意にして検査は道具に任せる。
  reg('set_notify_preference', D(tr('mcp.tool.setNotifyPreference')), { session_id: z.string().optional(), text: z.string().optional().describe(tr('mcp.notifyPref.textParam')), unread: z.array(z.string()).optional().describe(tr('mcp.notifyPref.unreadParam')), os: z.array(z.string()).optional().describe(tr('mcp.notifyPref.osParam')), phone: z.array(z.string()).optional().describe(tr('mcp.notifyPref.phoneParam')), whileFocused: z.boolean().optional().describe(tr('mcp.notifyPref.whileFocusedParam')), merge: z.boolean().optional().describe(tr('mcp.notifyPref.mergeParam')) });
  reg('propose_session_status', D(tr('mcp.tool.proposeSessionStatus')), { session_id: z.string().optional(), status: z.enum(['done', 'paused']), note: z.string().describe(tr('mcp.sessionStatus.noteParam')), return_on: z.string().optional().describe(tr('mcp.sessionStatus.returnOnParam')), return_time: z.string().optional().describe(tr('mcp.sessionStatus.returnTimeParam')), confirmed: z.boolean().optional().describe(tr('mcp.sessionStatus.confirmedParam')) });
  reg('stop_session', D(tr('mcp.tool.stopSession')), { session_id: z.string() });
  reg('resume_session', D(tr('mcp.tool.resumeSession')), { session_id: z.string(), account: z.string().optional().describe(tr('mcp.resumeSession.accountParam')) });
  reg('delete_session', D(tr('mcp.tool.deleteSession')), { session_id: z.string() });
  reg('get_usage', D(tr('mcp.tool.getUsage')), {});
  reg('open_in_hangar', D(tr('mcp.tool.openInHangar')), { session_id: z.string().optional(), project_id: z.string().optional() });
  reg('send_to_session', D(tr('mcp.tool.sendToSession')), { session_id: z.string(), text: z.string().describe(tr('mcp.sendToSession.textParam', { max: MAX_SEND_CHARS })), submit: z.boolean().optional().describe(tr('mcp.sendToSession.submitParam')) });
  reg('read_session_screen', D(tr('mcp.tool.readSessionScreen')), { session_id: z.string().optional(), lines: z.number().int().positive().optional().describe(tr('mcp.screen.linesParam', { max: MAX_SCREEN_LINES })) });
  reg('wait_for_session', D(tr('mcp.tool.waitForSession')), { session_id: z.string(), timeout_seconds: z.number().min(0).optional().describe(tr('mcp.wait.timeoutParam', { default: DEFAULT_WAIT_SECONDS, max: MAX_WAIT_SECONDS })) });
  const scheduleArgs = {
    kind: z.enum(['once', 'weekly', 'every']).describe(tr('mcp.schedule.kindParam')), at: z.string().optional().describe(tr('mcp.schedule.atParam')),
    days: z.array(z.number().int()).optional().describe(tr('mcp.schedule.daysParam')), time: z.string().optional().describe(tr('mcp.schedule.timeParam')),
    every_minutes: z.number().int().optional().describe(tr('mcp.schedule.everyParam', { min: SCHEDULE_MIN_EVERY_MINUTES })), prompt: z.string(),
    project_id: z.string().optional(), session_id: z.string().optional().describe(tr('mcp.schedule.sessionParam')), agent: z.string().optional(),
  };
  reg('list_schedules', D(tr('mcp.tool.listSchedules')), { project_id: z.string().optional() });
  reg('create_schedule', D(tr('mcp.tool.createSchedule')), scheduleArgs);
  reg('update_schedule', D(tr('mcp.tool.updateSchedule')), { schedule_id: z.string(), enabled: z.boolean().optional().describe(tr('mcp.schedule.enabledParam')), ...scheduleArgs, kind: scheduleArgs.kind.optional(), prompt: z.string().optional() });
  // 節は種類ごとに必須が違うので、ここでは全部を任意にし、検査は report/compose.ts に任せる。断りの文で足りない節を名指しできる。
  const section = z.string().optional();
  reg('draft_issue_report', D(tr('report.tool.draft')), {
    kind: z.enum(['bug', 'request']).describe(tr('report.param.kind')), title: z.string(),
    symptom: section, steps: section, cause: section, fix: section, problem: section, proposal: section, alternatives: section, notes: section,
  });
  // confirmed を任意にするのは、渡し忘れを SDK の型の失敗でなく、承認を求める断りの文で返すためである。
  reg('submit_issue_report', D(tr('report.tool.submit')), { draft_id: z.string(), confirmed: z.boolean().optional().describe(tr('report.param.confirmed')) });
  return server;
}

/**
 * MCP 専用の入口の検査。
 * Origin が無い要求は通す。MCP クライアントは Origin を送らないので、ここで弾くと一切使えなくなる。
 *
 * 鍵は 2 種類ある。
 * 本体のトークンはどちらの入口も開ける。`hangar mcp install` が user スコープに登録する共通の URL がこれを使う。
 * run に配るセッション別の秘密は、その run のセッションの入口だけを開ける。
 * hangar が起こした claude には後者しか渡さない。
 * 本体のトークンを渡すと、その claude は自分の `--mcp-config`（自分は読める）から鍵を取り出し、
 * 共通の `/mcp` と `/api` に回れてしまう。URL で閉じ込めても、鍵が共通なら閉じない。
 *
 * 断る理由は区別せずにそろえる。攻撃者に手掛かりを与えない。
 */
function mcpGuard(c: Context, deps: { token: string; port: number; db: ToolDeps['db'] }, sessionId: string | null): Response | null {
  const origin = c.req.header('origin');
  if (origin !== undefined && !mcpAllowedOrigins(deps.port).includes(origin)) return c.json({ error: 'origin not allowed' }, 403);
  const got = tokenFromRequest(c.req.raw.headers, c.req.header('cookie'));
  if (tokenEquals(got, deps.token)) return null;
  if (sessionId !== null && mcpSecretMatches(deps.db, sessionId, got)) return null;
  return c.json({ error: 'unauthorized' }, 401);
}

/**
 * 状態を持たない Streamable HTTP。要求ごとにサーバとトランスポートを作る。
 *
 * GET の SSE（サーバから送るための開いたままの流れ）は開かず、仕様どおり 405 を返す。
 * 要求ごとに作ったトランスポートの流れには、送るものが何も無い。
 * それでいて開いておくと、hangar が止まったときに流れが切れ、Claude Code はサーバが落ちたと見て、
 * 繋ぎ直しを 5 回（1、2、4、8 秒おき）試したあとに諦める。
 * 諦めた後は、hangar を起こし直しても、利用者が /mcp で繋ぎ直すまで ECONNREFUSED のままになる。
 * 開かなければ、止まっている間に呼ばれなかった claude は切れたことに気付かず、起こし直した後の次の呼び出しがそのまま通る。
 */
/** ブラウザで開く口が渡されなかったときの開き方。 */
async function openWithOs(url: string): Promise<void> {
  const c = openTargetCommand(url);
  const r = await execFile(c.file, c.args, process.platform === 'win32' ? { untilExit: true } : undefined);
  if (r.code !== 0) throw new Error(r.stderr.trim() || `${c.file} exit ${r.code}`);
}

/**
 * hook の受け口が本文を読む口。sessions.provider の値から、その driver の許可と質問の面（AskSource）を返す。
 * 受け口は hook の形を知らず、読むのは driver の parseHook である。
 */
export type AsksOf = (provider: string) => AskSource;

/** 要求が長く待つ道具の呼び出しか。読めない本文は、ふつうの要求としてトランスポートの断りに任せる。 */
async function isLongCall(req: Request): Promise<boolean> {
  try {
    const m = await req.json() as { method?: unknown; params?: { name?: unknown } };
    return m.method === 'tools/call' && m.params?.name === 'wait_for_session';
  } catch {
    return false;
  }
}

/** asksOf を渡さなければ、hook の本文は読まずに 204 を返す。 */
export function createMcpApp(given: ToolDeps & { token: string; asksOf?: AsksOf }): Hono {
  // 問い合わせの下書きは要求をまたいで残すので、口はアプリに 1 つだけ作る（MCP のサーバは要求ごとに作り直す）。
  const deps = given.report ? given : {
    ...given,
    report: new ReportService(realReportDeps({ db: given.db, deviceId: given.deviceId, language: given.language ?? defaultLanguage, openUrl: given.openUrl ?? openWithOs })),
  };
  const app = new Hono();
  const handle = async (req: Request, sessionId: string | null) => {
    if (req.method === 'GET') return new Response(null, { status: 405, headers: { allow: 'POST, DELETE' } });
    // 長く待つ道具だけ SSE で返す。Claude Code は POST の応答の見出しを 60 秒しか待たないので、JSON で答えると待っている間に切られる（2.1.316 で実測）。
    const stream = req.method === 'POST' && await isLongCall(req.clone());
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: !stream });
    await buildMcpServer(deps, { sessionId }).connect(transport);
    return transport.handleRequest(req);
  };
  app.all('/', (c) => mcpGuard(c, deps, null) ?? handle(c.req.raw, null));
  app.all('/s/:sessionId', (c) => {
    const id = c.req.param('sessionId');
    // 鍵の検査を先に済ませる。セッションの有無を、鍵を持たない相手に教えない。
    const denied = mcpGuard(c, deps, id);
    if (denied) return denied;
    if (!deps.db.prepare('select 1 from sessions where id = ? and deleted_at is null').get(id)) return c.json({ error: 'session not found' }, 404);
    return handle(c.req.raw, id);
  });
  /**
   * hook の受け口。hangar が起こしたエージェントの hook（Claude は provider/claude-code/launch/hookSettings.ts）が、台本を通して入力を送ってくる。
   * MCP の入口と同じ鍵で開く。エージェントが持っているのは run の秘密だけだからである。
   * 本文は、セッションの provider の driver の parseHook で読む。いま読むのは質問の出入りと、道具の許可の確認だけで、ほかの出来事は書かずに 204 を返す。
   * 無いセッションと消したセッションは、読まずに 204 を返す（書く側も、そのセッションの行が無ければ書かない）。
   */
  app.post('/s/:sessionId/hook', async (c) => {
    const id = c.req.param('sessionId');
    const denied = mcpGuard(c, deps, id);
    if (denied) return denied;
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid json' }, 400);
    }
    const row = deps.db.prepare('select provider from sessions where id = ? and deleted_at is null').get(id) as { provider: string } | undefined;
    const asks = row && given.asksOf ? given.asksOf(row.provider).parseHook?.(body) ?? [] : [];
    const now = Date.now();
    for (const a of asks) {
      if (a.kind === 'question') applyQuestionHook(deps.db, id, a.hook, now);
      else if (deps.permissionAsks) applyPermissionHook(deps.db, id, { providerSessionId: a.providerSessionId, ask: a.ask }, deps.permissionAsks, now);
    }
    return c.body(null, 204);
  });
  return app;
}
