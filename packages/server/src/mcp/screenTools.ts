import { getSession } from '../db/queries.ts';
import { msg } from '../i18n/message.ts';
import { aliveRunForSession } from '../runs/queries.ts';
import { ToolError, type ToolContext, type ToolDeps } from './tools.ts';

/**
 * send_to_session の text の上限（文字数）。
 * 貼り付けは tmux の set-buffer に text を引数として渡す。Windows の psmux は CreateProcess の上限（コマンドライン全体で 32,767 文字）に当たる。
 * 8,000 字なら、日本語でもほかの引数と合わせて上限の内に収まる。
 * 指示として送る量としても十分で、長い内容は「ファイルに書いてパスを送る」ほうが受け手にとっても確かである。
 */
export const MAX_SEND_CHARS = 8000;

/** read_session_screen の lines の既定。ふつうの端末の高さ（40 行ほど）の 1 画面分。 */
export const DEFAULT_SCREEN_LINES = 40;

/**
 * read_session_screen の lines の上限。
 * 読めるのは画面にいま見えている範囲だけ（スクロールバックは含まない）で、hangar の画面の高さは 100 行に届かない。
 * 上限を越えた指定は、断らずに上限に丸める。
 */
export const MAX_SCREEN_LINES = 200;


const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined);

/**
 * 貼り付けに入れてよい文字だけにする。
 * 貼り付けは ESC[200~ と ESC[201~ で囲んで届く。text の中に ESC[201~ があると、そこで貼り付けが終わり、後ろが素のキー入力として解釈される。
 * なので ESC を含む制御文字は落とす。改行（LF）とタブは残し、CRLF と CR は LF にそろえる。
 */
export function sanitizeInput(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '');
}

/**
 * このセッションの、この PC の hangar が動かしている画面（tmux の名前）。
 * 画面に触れない理由は、断りの文を分けて返す。
 */
function paneOf(deps: ToolDeps, id: string): string {
  const run = aliveRunForSession(deps.db, id, deps.deviceId);
  if (run) {
    if (run.deviceId !== deps.deviceId) {
      const d = deps.db.prepare('select name from devices where id = ?').get(run.deviceId) as { name: string | null } | undefined;
      throw new ToolError(msg('mcp.screen.otherDevice', { device: d?.name ?? run.deviceId }));
    }
    return run.tmuxName;
  }
  // run が無くても live に載っていれば、hangar の外の端末で動いている。
  const s = getSession(deps.db, deps.live(), id, { deviceId: deps.deviceId });
  if (s?.live) throw new ToolError(msg('mcp.screen.outside'));
  throw new ToolError(msg('mcp.screen.notRunning'));
}

function requireTarget(deps: ToolDeps, id: string): void {
  if (!getSession(deps.db, deps.live(), id, { deviceId: deps.deviceId })) throw new ToolError(msg('mcp.error.sessionNotFound', { id }));
}

export async function sendToSessionTool(deps: ToolDeps, ctx: ToolContext, args: Record<string, unknown>) {
  const id = str(args.session_id);
  if (!id) throw new ToolError(msg('mcp.args.sessionIdRequired'));
  requireTarget(deps, id);
  // 送るのはどのセッションにも許すが、自分自身には送らない。自分に送った入力は、自分の次の入力として返ってくる。
  if (ctx.sessionId === id) throw new ToolError(msg('mcp.screen.self'));
  const raw = typeof args.text === 'string' ? args.text : '';
  if (!raw.trim()) throw new ToolError(msg('mcp.sendToSession.textRequired'));
  if (raw.length > MAX_SEND_CHARS) throw new ToolError(msg('mcp.sendToSession.textTooLong', { max: MAX_SEND_CHARS }));
  const text = sanitizeInput(raw);
  const submit = typeof args.submit === 'boolean' ? args.submit : true;
  const name = paneOf(deps, id);
  if (!deps.runs.sendInput) throw new ToolError(msg('mcp.screen.noPanes'));
  try {
    await deps.runs.sendInput(name, text, submit);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    throw new ToolError(msg(process.platform === 'win32' ? 'mcp.sendToSession.failedWindows' : 'mcp.sendToSession.failed', { reason }));
  }
  return { session_id: id, sent_chars: text.length, submitted: submit };
}

export function readSessionScreenTool(deps: ToolDeps, ctx: ToolContext, args: Record<string, unknown>) {
  const id = str(args.session_id) ?? ctx.sessionId;
  if (!id) throw new ToolError(msg('mcp.args.sessionIdRequired'));
  requireTarget(deps, id);
  const name = paneOf(deps, id);
  if (!deps.runs.readScreen) throw new ToolError(msg('mcp.screen.noPanes'));
  const raw = deps.runs.readScreen(name);
  if (raw === null) throw new ToolError(msg('mcp.screen.notRunning'));
  const asked = typeof args.lines === 'number' && Number.isFinite(args.lines) ? Math.floor(args.lines) : DEFAULT_SCREEN_LINES;
  const n = Math.min(Math.max(asked, 1), MAX_SCREEN_LINES);
  // 画面の下の空行は、画面の高さの余りなので落とす。
  const lines = raw.replace(/\s+$/, '').split('\n');
  const s = getSession(deps.db, deps.live(), id, { deviceId: deps.deviceId });
  return { session_id: id, status: s?.live ?? null, waiting_for: s?.waitingFor ?? null, screen: lines.slice(-n).join('\n') };
}
