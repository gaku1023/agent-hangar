import { captureOutput, type CaptureOptions, type Captured } from '../platform/capture.ts';
import { needsShell } from '../platform/exec.ts';
import { findTool } from '../report/real.ts';

type Capture = (file: string, args: string[], o: CaptureOptions) => Promise<Captured>;

const GH_TIMEOUT_MS = 20_000;
/** 分からなかったときに、聞き直すまで空ける長さ。gh が無い、ログインしていない PC で毎回呼ばないため。 */
const RETRY_MS = 5 * 60_000;
const LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\[bot\])?$/;

/**
 * 今の PC の GitHub のユーザー名（gh api user）を引く口。分かったものは覚え、分からなければ null を返し、しばらく聞き直さない。
 * 本文を渡してよい投稿者が「自分」かどうかの判定に使う。分からないときは誰も自分とみなさない（本文は渡らない側に倒れる）。
 * 同時に呼ばれても gh は 1 回だけ起こす。
 */
export function ghLoginResolver(o: { env?: NodeJS.ProcessEnv; capture?: Capture; now?: () => number } = {}): () => Promise<string | null> {
  const env = o.env ?? process.env;
  const capture = o.capture ?? captureOutput;
  const now = o.now ?? Date.now;
  let login: string | null = null;
  let retryAt = 0;
  let pending: Promise<string | null> | null = null;
  const ask = async (): Promise<string | null> => {
    try {
      const bin = findTool('gh', env);
      if (!bin) return null;
      const r = await capture(bin, ['api', 'user', '--jq', '.login'], { timeoutMs: GH_TIMEOUT_MS, env, shell: needsShell(bin) });
      const name = r.stdout.trim();
      return r.code === 0 && LOGIN_RE.test(name) ? name : null;
    } catch {
      return null;
    }
  };
  return async () => {
    if (login) return login;
    if (now() < retryAt) return null;
    pending ??= ask().then((v) => {
      login = v;
      if (!v) retryAt = now() + RETRY_MS;
      return v;
    }).finally(() => { pending = null; });
    return pending;
  };
}
