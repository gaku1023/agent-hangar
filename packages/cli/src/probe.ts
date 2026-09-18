/**
 * 端末から見た「サーバが居るか」「鍵が合っているか」の確かめ方と、失敗の言い方。
 * 鍵は端末に出してよいが、ログと失敗の文には出さない。
 */

/** 認証の要る経路を 1 つ叩いた結果。 */
export type AuthProbeResult =
  | { ok: true }
  | { ok: false; reason: 'down' }
  | { ok: false; reason: 'unauthorized'; status: number }
  | { ok: false; reason: 'error'; status: number };

/** 確かめ方を差し替えられるようにした型。テストは偽物を渡せる。 */
export type AuthProbe = (port: number, token: string) => Promise<AuthProbeResult>;

/**
 * 鍵の要る軽い経路。
 * 使用量の現在値を返すだけで、ディスクもデータベースも触らない。
 */
const AUTH_PROBE_PATH = '/api/usage';

/** 応答の本文を捨てる。読まないままにすると、接続が開いたままになることがある。 */
async function drain(r: Response): Promise<void> {
  try {
    await r.arrayBuffer();
  } catch {
    /* 読めなくても構わない */
  }
}

/**
 * そのポートで hangar が応答するか。
 * `/health` は認証を通さないので、鍵を持たずに確かめられる。
 * 分かるのは「何かが応答する」ことだけで、鍵が合っているかは分からない。
 */
export async function probeHealth(port: number, timeoutMs = 1000): Promise<boolean> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    await drain(r);
    return r.ok;
  } catch {
    return false;
  }
}

/**
 * 手元の鍵で、認証の要る経路を 1 つ叩く。
 * `/health` だけでは「そのポートで何かが応答する」ことしか分からず、
 * `HANGAR_HOME` がサーバとずれていれば、違う鍵を書いたまま成功と言ってしまう。
 * 鍵は問い合わせ文字列ではなく Authorization の見出しで送る。URL はログに残りうるためである。
 */
export async function probeAuthorized(port: number, token: string, timeoutMs = 1500): Promise<AuthProbeResult> {
  let r: Response;
  try {
    r = await fetch(`http://127.0.0.1:${port}${AUTH_PROBE_PATH}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return { ok: false, reason: 'down' };
  }
  await drain(r);
  if (r.ok) return { ok: true };
  if (r.status === 401 || r.status === 403) return { ok: false, reason: 'unauthorized', status: r.status };
  return { ok: false, reason: 'error', status: r.status };
}

/** サーバが居ないポートを指したときの案内。開く前にこれを出す。 */
export function serverDownMessage(port: number): string {
  return `ポート ${port} でサーバが動いていません。\`hangar start\` で起動してください。`;
}

/**
 * 例外を 1 行にする。
 * 端末に生のスタックを出しても、次に何をすればよいかは分からない。
 */
export function oneLineError(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  return (raw.split('\n')[0] ?? '').trim() || '原因の分からない失敗です';
}

/**
 * 起動に失敗したときの 1 行。
 * よくある失敗は理由と次の一手を日本語で言い、それ以外も 1 行にたたむ。
 */
export function startErrorMessage(e: unknown, port: number): string {
  const code = (e as NodeJS.ErrnoException | null)?.code;
  if (code === 'EADDRINUSE') {
    return `ポート ${port} は既に使われています。別の hangar が動いていないか確かめてください（\`--port\` で別の番号も指定できます）。`;
  }
  if (code === 'EACCES') {
    return `ポート ${port} を開く権限がありません。\`--port\` で 1024 以上の番号を指定してください。`;
  }
  if (code === 'EADDRNOTAVAIL') {
    return `ポート ${port} を開けません。127.0.0.1 が使える状態か確かめてください。`;
  }
  return `サーバを起動できませんでした: ${oneLineError(e)}`;
}
