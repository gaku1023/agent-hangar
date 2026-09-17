export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === '/health') return Response.json({ ok: true });
    if (url.pathname === '/d1' && req.method === 'POST') {
      await env.DB.prepare('create table if not exists kv (k text primary key, v text, updated_at integer)').run();
      await env.DB.prepare('insert or replace into kv values (?, ?, ?)').bind('ping', 'pong', Date.now()).run();
      const row = await env.DB.prepare('select * from kv where k = ?').bind('ping').first();
      return Response.json(row);
    }
    if (url.pathname === '/r2' && req.method === 'PUT') {
      await env.BUCKET.put('spike/hello.bin', req.body);
      const head = await env.BUCKET.head('spike/hello.bin');
      return Response.json({ size: head?.size });
    }
    return new Response('not found', { status: 404 });
  },
};
