interface Env { DB: D1Database; TOKEN: string }
interface Ev { run: string; seq: number; at: string; kind: string; detail: Record<string, string> }

const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname !== "/e") return json({ error: "not found" }, 404);
    if (req.headers.get("authorization") !== `Bearer ${env.TOKEN}`) return json({ error: "unauthorized" }, 401);
    if (req.method === "POST") {
      let evs: Ev[];
      try { evs = await req.json(); if (!Array.isArray(evs)) throw 0; } catch { return json({ error: "bad body" }, 400); }
      if (evs.length === 0) return json({ stored: 0 });
      const stmt = env.DB.prepare("INSERT OR IGNORE INTO events (run, seq, at, kind, detail) VALUES (?, ?, ?, ?, ?)");
      const rs = await env.DB.batch(evs.map((e) => stmt.bind(e.run, e.seq, e.at, e.kind, JSON.stringify(e.detail ?? {}))));
      return json({ stored: rs.reduce((n, r) => n + (r.meta.changes ?? 0), 0) });
    }
    if (req.method === "GET") {
      const run = url.searchParams.get("run");
      if (!run) return json({ error: "run required" }, 400);
      const after = Number(url.searchParams.get("after") ?? -1);
      const { results } = await env.DB.prepare(
        "SELECT run, seq, at, kind, detail FROM events WHERE run = ? AND seq > ? ORDER BY seq ASC LIMIT 500",
      ).bind(run, after).all<{ run: string; seq: number; at: string; kind: string; detail: string }>();
      return json(results.map((r) => ({ ...r, detail: JSON.parse(r.detail) })));
    }
    return json({ error: "method" }, 405);
  },
};
