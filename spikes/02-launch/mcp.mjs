// spikes/02-launch/mcp.mjs
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { z } from 'zod';

export const TOKEN = 'spike-token';
export const app = new Hono();
const log = (...a) => console.log(new Date().toISOString(), ...a);

export function build(sessionId) {
  const server = new McpServer({ name: 'hangar-spike', version: '0.0.1' });
  server.registerTool('hangar_ping', {
    description: 'agent-hangar への疎通確認。呼ばれたら必ず成功を返す。',
    inputSchema: { note: z.string().optional() },
  }, async ({ note }) => {
    log('hangar_ping from session', sessionId, 'note=', note);
    return { content: [{ type: 'text', text: `pong from hangar (session=${sessionId})` }] };
  });
  return server;
}

app.all('/mcp/s/:sid', async (c) => {
  log(c.req.method, c.req.path, 'auth=', c.req.header('authorization') ? 'yes' : 'no', 'origin=', c.req.header('origin') ?? '-');
  if (c.req.header('authorization') !== `Bearer ${TOKEN}`) return c.text('unauthorized', 401);
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await build(c.req.param('sid')).connect(transport);
  return transport.handleRequest(c.req.raw);
});

serve({ fetch: app.fetch, port: 4191, hostname: '127.0.0.1' }, () => log('mcp on http://127.0.0.1:4191'));
