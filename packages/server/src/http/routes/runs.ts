import type { Hono } from 'hono';
import { MAX_JUMP_HEADS, PROMPT_HEAD_LEN as HEAD_LEN, type LaunchParams } from '@agent-hangar/shared';
import { RunError } from '../../runs/manager.ts';
import type { JumpFrom } from '../../runs/promptJump.ts';
import { decodeTerminalRequest } from '../../runs/terminal.ts';
import { errorText, translatorOf } from '../../i18n/message.ts';
import type { AppDeps, LanguageDeps } from '../deps.ts';
import { beforeLaunchOf, BODY_LIMITS, externalOf, readJson, runResult, runResultAsync, tooLargeResult } from './common.ts';

/** run の経路が使う依存。 */
export type RunRouteDeps = Pick<AppDeps, 'runs' | 'sync' | 'resumeHere' | 'external' | 'token'> & LanguageDeps;

/**
 * run の経路。
 * 起動と停止、タブ、ターミナルで開く、指示へ跳ぶ、に加えて、セッションから run を起こす口（resume-here、resume、fork、attach、adopt）を持つ。
 */
export function runRoutes(api: Hono, deps: RunRouteDeps): void {
  const language = deps.language;
  const tr = translatorOf(deps.language);
  const external = externalOf(deps);
  const beforeLaunch = beforeLaunchOf(deps);

  // 他端末の本文を手元に写してから再開する。手元の方が小さいときだけ 409 で確認を求める。
  api.post('/sessions/:id/resume-here', async (c) => {
    const b = await readJson(c, BODY_LIMITS.default);
    if (b.tooLarge) return tooLargeResult(c, BODY_LIMITS.default, tr);
    const body = (b.value ?? {}) as { overwrite?: unknown };
    try {
      const r = deps.resumeHere(c.req.param('id'), body.overwrite === true);
      return 'error' in r ? c.json(r, 409) : c.json(r);
    } catch (e) {
      if (e instanceof RunError) return c.json({ error: errorText(language(), e) }, e.status);
      throw e;
    }
  });

  api.get('/runs', (c) => c.json(deps.runs.listAlive()));
  api.post('/runs', async (c) => {
    const b = await readJson(c, BODY_LIMITS.default);
    if (b.tooLarge) return tooLargeResult(c, BODY_LIMITS.default, tr);
    const params = (b.value ?? null) as LaunchParams | null;
    if (!params || typeof params !== 'object') return c.json({ error: tr('http.request.notJson') }, 400);
    // 他端末の最新を先に取り込む。間に合わなくても起動する（結果は見ない）。
    await beforeLaunch();
    return runResult(c, language, () => deps.runs.start(params), 201);
  });
  // ターミナルの包み方（~/.agent-hangar/shell/claude.zsh）からの起動。断ったら、包み方は素の claude を起動する。
  api.post('/runs/terminal', async (c) => {
    const b = await readJson(c, BODY_LIMITS.terminal);
    if (b.tooLarge) return tooLargeResult(c, BODY_LIMITS.terminal, tr);
    const req = decodeTerminalRequest(b.value);
    if (!req) return c.json({ error: tr('http.request.badShape') }, 400);
    await beforeLaunch();
    return runResult(c, language, () => deps.runs.startFromTerminal(req), 201);
  });
  api.delete('/runs/:id', (c) => runResult(c, language, () => deps.runs.kill(c.req.param('id'))));
  // タブの追加と削除は本文を取らない。UI は content-type だけを付けた空の要求を送る。
  api.post('/runs/:id/tabs', (c) => runResult(c, language, () => deps.runs.openTab(c.req.param('id')), 201));
  api.delete('/runs/:id/tabs/:tabId', (c) => {
    // closeTab は持ち主を確かめないので、ここで URL の run のタブかを見る。
    // 見ないと、別の run の URL から他人のタブの tmux セッションを落とせてしまう。
    const tabId = c.req.param('tabId');
    const t = deps.runs.getTab(tabId);
    if (!t || t.runId !== c.req.param('id')) return c.json({ error: tr('run.tab.notFound') }, 404);
    return runResult(c, language, () => deps.runs.closeTab(tabId));
  });
  api.post('/runs/:id/open-terminal', async (c) => {
    const run = deps.runs.getRun(c.req.param('id'));
    if (!run) return c.json({ error: tr('run.error.notFound') }, 404);
    const b = await readJson(c, BODY_LIMITS.default);
    if (b.tooLarge) return tooLargeResult(c, BODY_LIMITS.default, tr);
    const body = (b.value ?? {}) as { tabId?: string };
    // tabId を省いたときは Claude のタブを開く。タブ 0 の id は run の id である。
    const tabId = body.tabId ?? run.id;
    const t = deps.runs.getTab(tabId);
    if (!t || t.runId !== run.id) return c.json({ error: tr('run.tab.notFound') }, 404);
    // 終了した run の Claude のタブは繋ぎ先がもう無い。シェルタブは終了後も開いてよい。
    if (!deps.runs.attachTarget(tabId)) return c.json({ error: tr('run.error.alreadyEnded') }, 409);
    return external(c, () => deps.external.openTerminal({ tmuxName: t.tmuxName }));
  });
  // 目次で押した指示へ、Claude のタブを transcript の中で跳ばす。本文には書き出し（HEAD_LEN 字）だけを並べて受ける。
  api.post('/runs/:id/jump', async (c) => {
    const b = await readJson(c, BODY_LIMITS.default);
    if (b.tooLarge) return tooLargeResult(c, BODY_LIMITS.default, tr);
    const body = (b.value ?? {}) as { heads?: unknown; index?: unknown; from?: unknown };
    const heads = body.heads;
    const okHeads = Array.isArray(heads) && heads.length > 0 && heads.length <= MAX_JUMP_HEADS && heads.every((h) => typeof h === 'string' && h.length <= HEAD_LEN);
    const index = body.index;
    if (!okHeads || typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= heads.length || (body.from !== 'top' && body.from !== 'bottom')) {
      return c.json({ error: tr('run.jump.badRequest', { headLen: HEAD_LEN, maxHeads: MAX_JUMP_HEADS }) }, 400);
    }
    return runResultAsync(c, language, () => deps.runs.jumpToPrompt(c.req.param('id'), heads as string[], index, body.from as JumpFrom));
  });
  api.post('/runs/:id/leave-transcript', (c) => runResultAsync(c, language, () => deps.runs.leaveTranscript(c.req.param('id'))));
  api.post('/sessions/:id/resume', async (c) => { await beforeLaunch(); return runResult(c, language, () => deps.runs.resume(c.req.param('id')), 201); });
  api.post('/sessions/:id/fork', async (c) => { await beforeLaunch(); return runResult(c, language, () => deps.runs.fork(c.req.param('id')), 201); });
  // バックグラウンドのサービスが持つセッションに、hangar の tmux からつなぐ。本文はその claude が書くので、他端末の取り込みは待たない。
  api.post('/sessions/:id/attach', (c) => runResult(c, language, () => deps.runs.attach(c.req.param('id')), 201));
  // hangar の外のターミナルで動く claude を止め、バックグラウンドに移してからつなぐ。
  api.post('/sessions/:id/adopt', (c) => runResultAsync(c, language, () => deps.runs.adopt(c.req.param('id')), 201));
}
