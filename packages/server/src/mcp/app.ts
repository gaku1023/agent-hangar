import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { tokenEquals, tokenFromRequest } from '../auth/request.ts';
import { VERSION } from '../boot/options.ts';
import { defaultLanguage } from '../i18n/language.ts';
import { errorText, translatorOf } from '../i18n/message.ts';
import { mcpSecretMatches } from '../runs/secrets.ts';
import { callTool, type ToolContext, type ToolDeps } from './tools.ts';

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
    server.registerTool(name, { description, inputSchema }, async (args: Record<string, unknown>) => {
      try {
        return { content: [{ type: 'text' as const, text: JSON.stringify(callTool(deps, ctx, name, args), null, 2) }] };
      } catch (e) {
        return { content: [{ type: 'text' as const, text: errorText(language(), e) }], isError: true };
      }
    });
  };
  reg('list_projects', D(tr('mcp.tool.listProjects')), {});
  reg('get_project', D(tr('mcp.tool.getProject')), { project_id: z.string() });
  reg('update_project', D(tr('mcp.tool.updateProject')), { project_id: z.string(), status: STATUS.optional(), add_todos: z.array(z.string()).optional(), toggle_todos: z.array(z.string()).optional(), propose_done: z.array(z.object({ todo_id: z.string(), note: z.string() })).optional(), append_memo: z.string().optional() });
  reg('list_sessions', D(tr('mcp.tool.listSessions')), { project_id: z.string().optional(), running: z.boolean().optional(), limit: z.number().int().positive().optional() });
  reg('search_sessions', D(tr('mcp.tool.searchSessions')), { query: z.string(), project_id: z.string().optional(), since: z.number().optional(), until: z.number().optional(), file: z.string().optional(), limit: z.number().int().positive().optional() });
  reg('get_transcript', D(tr('mcp.tool.getTranscript')), { session_id: z.string().optional(), from_seq: z.number().int().optional(), limit: z.number().int().positive().optional(), include_tools: z.boolean().optional() });
  reg('create_session', D(tr('mcp.tool.createSession')), { project_id: z.string(), name: z.string().optional(), prompt: z.string().optional(), model: z.string().optional(), effort: z.string().optional(), permission_mode: z.string().optional(), scratch: z.boolean().optional() });
  reg('set_session_summary', D(tr('mcp.tool.setSessionSummary')), { session_id: z.string().optional(), title: z.string(), one_liner: z.string(), body: z.string(), state: STATE, next_steps: z.array(z.string()) });
  reg('set_turn_intent', D(tr('mcp.tool.setTurnIntent')), { session_id: z.string().optional(), text: z.string() });
  reg('propose_session_status', D(tr('mcp.tool.proposeSessionStatus')), { session_id: z.string().optional(), status: z.enum(['done', 'paused']), note: z.string().describe(tr('mcp.sessionStatus.noteParam')), return_on: z.string().optional().describe(tr('mcp.sessionStatus.returnOnParam')), return_time: z.string().optional().describe(tr('mcp.sessionStatus.returnTimeParam')), confirmed: z.boolean().optional().describe(tr('mcp.sessionStatus.confirmedParam')) });
  reg('set_session_memo', D(tr('mcp.tool.setSessionMemo')), { session_id: z.string().optional(), text: z.string() });
  reg('get_usage', D(tr('mcp.tool.getUsage')), {});
  reg('open_in_hangar', D(tr('mcp.tool.openInHangar')), { session_id: z.string().optional(), project_id: z.string().optional() });
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
export function createMcpApp(deps: ToolDeps & { token: string }): Hono {
  const app = new Hono();
  const handle = async (req: Request, sessionId: string | null) => {
    if (req.method === 'GET') return new Response(null, { status: 405, headers: { allow: 'POST, DELETE' } });
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
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
  return app;
}
