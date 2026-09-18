import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { Hono, type MiddlewareHandler } from 'hono';
import { z } from 'zod';
import { tokenFromRequest } from '../http/auth.ts';
import { callTool, type ToolContext, type ToolDeps } from './tools.ts';

export const MCP_VERSION = '0.2.0';

/**
 * MCP の入口が受け付ける Origin。
 * http/auth.ts の一覧とは別にする。開発用の 5173 は MCP に要らないためである。
 */
export const MCP_ALLOWED_ORIGINS = ['http://localhost:4177', 'http://127.0.0.1:4177', 'tauri://localhost'];

/** 説明文に「agent-hangar」を含める。Claude Code はツール定義を遅延して読むので、検索で当たる語が要る。 */
const D = (s: string) => `agent-hangar: ${s}`;
const STATUS = z.enum(['active', 'paused', 'done', 'archived']);
const STATE = z.enum(['in_progress', 'done', 'blocked', 'abandoned']);

export function buildMcpServer(deps: ToolDeps, ctx: ToolContext): McpServer {
  const server = new McpServer({ name: 'agent-hangar', version: MCP_VERSION });
  const reg = (name: string, description: string, inputSchema: Record<string, z.ZodTypeAny>) => {
    server.registerTool(name, { description, inputSchema }, async (args: Record<string, unknown>) => {
      try {
        return { content: [{ type: 'text' as const, text: JSON.stringify(callTool(deps, ctx, name, args), null, 2) }] };
      } catch (e) {
        return { content: [{ type: 'text' as const, text: e instanceof Error ? e.message : String(e) }], isError: true };
      }
    });
  };
  reg('list_projects', D('プロジェクトの一覧。ステータス、パス、未完 TODO 数、最終活動を返す。'), {});
  reg('get_project', D('プロジェクトの詳細。TODO、メモ、直近のセッション、アーティファクト。'), { project_id: z.string() });
  reg('update_project', D('プロジェクトのステータスを変え、TODO を足すか反転し、メモに追記する。'), { project_id: z.string(), status: STATUS.optional(), add_todos: z.array(z.string()).optional(), toggle_todos: z.array(z.string()).optional(), append_memo: z.string().optional() });
  reg('list_sessions', D('セッションの一覧。project_id、running、limit で絞る。'), { project_id: z.string().optional(), running: z.boolean().optional(), limit: z.number().int().positive().optional() });
  reg('search_sessions', D('過去のセッションを全文検索する。題名、要約の 1 文、一致箇所の抜粋、再開コマンドを返す。'), { query: z.string(), project_id: z.string().optional(), since: z.number().optional(), until: z.number().optional(), provider: z.string().optional(), file: z.string().optional(), limit: z.number().int().positive().optional() });
  reg('get_transcript', D('セッションの本文を正規化イベントで返す。セッション別 URL では session_id を省ける。'), { session_id: z.string().optional(), from_seq: z.number().int().optional(), limit: z.number().int().positive().optional(), include_tools: z.boolean().optional() });
  reg('create_session', D('プロジェクトで新しい Claude Code セッションを tmux 上に起動する。'), { project_id: z.string(), name: z.string().optional(), prompt: z.string().optional(), model: z.string().optional(), effort: z.string().optional(), permission_mode: z.string().optional(), scratch: z.boolean().optional() });
  reg('set_session_summary', D('このセッションの要約を更新する。依頼の完了、方針の変更、中断のときに呼ぶ。'), { session_id: z.string().optional(), title: z.string(), one_liner: z.string(), body: z.string(), state: STATE, next_steps: z.array(z.string()) });
  reg('set_session_memo', D('セッションの人間向け 1 行メモを書く。'), { session_id: z.string().optional(), text: z.string() });
  reg('get_usage', D('Claude の 5 時間と 7 日のレート制限の使用率と最終更新時刻。statusline から届いた最新の値。'), {});
  reg('open_in_hangar', D('セッションかプロジェクトを hangar の UI で開く URL とディープリンクを返す。'), { session_id: z.string().optional(), project_id: z.string().optional() });
  return server;
}

/**
 * MCP 専用の認証。
 * Origin が無い要求は通す。MCP クライアントは Origin を送らないので、ここで弾くと一切使えなくなる。
 */
function mcpAuth(token: string): MiddlewareHandler {
  return async (c, next) => {
    const origin = c.req.header('origin');
    if (origin !== undefined && !MCP_ALLOWED_ORIGINS.includes(origin)) return c.json({ error: 'origin not allowed' }, 403);
    if (tokenFromRequest(c.req.raw.headers, c.req.header('cookie')) !== token) return c.json({ error: 'unauthorized' }, 401);
    await next();
  };
}

/** 状態を持たない Streamable HTTP。要求ごとにサーバとトランスポートを作る。 */
export function createMcpApp(deps: ToolDeps & { token: string }): Hono {
  const app = new Hono();
  app.use('*', mcpAuth(deps.token));
  const handle = async (req: Request, sessionId: string | null) => {
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await buildMcpServer(deps, { sessionId }).connect(transport);
    return transport.handleRequest(req);
  };
  app.all('/', (c) => handle(c.req.raw, null));
  app.all('/s/:sessionId', (c) => {
    const id = c.req.param('sessionId');
    if (!deps.db.prepare('select 1 from sessions where id = ? and deleted_at is null').get(id)) return c.json({ error: 'session not found' }, 404);
    return handle(c.req.raw, id);
  });
  return app;
}
