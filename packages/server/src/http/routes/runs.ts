import type { Hono } from 'hono';
import { MAX_JUMP_HEADS, PROMPT_HEAD_LEN as HEAD_LEN, type LaunchParams, type TakeoverLockedDto } from '@agent-hangar/shared';
import { sessionLock } from '../../db/queries.ts';
import { RunError } from '../../runs/manager.ts';
import { resumeHereAllowed } from '../../sync/takeover.ts';
import type { JumpFrom } from '../../provider/claude-code/screen/promptJump.ts';
import { decodeTerminalRequest, terminalAgentOf } from '../../runs/terminal.ts';
import { interruptedGroup, setInterruptedDismissed } from '../../runs/interrupted.ts';
import { resumeHerePlan } from '../../runs/handover.ts';
import { errorText, translatorOf } from '../../i18n/message.ts';
import type { AppDeps, LanguageDeps } from '../deps.ts';
import { beforeLaunchOf, BODY_LIMITS, externalOf, readJson, runResult, runResultAsync, sessionOf, tooLargeResult } from './common.ts';

/** run の経路が使う依存。 */
export type RunRouteDeps = Pick<AppDeps, 'runs' | 'sync' | 'resumeHere' | 'resumeHereReplace' | 'external' | 'token' | 'db' | 'deviceId' | 'live' | 'hub' | 'takeover'> & LanguageDeps;

/**
 * run の経路。
 * 起動と停止、タブ、ターミナルで開く、指示へ跳ぶ、に加えて、セッションから run を起こす口（resume-here、resume、fork、attach、adopt）を持つ。
 */
export function runRoutes(api: Hono, deps: RunRouteDeps): void {
  const language = deps.language;
  const tr = translatorOf(deps.language);
  const external = externalOf(deps);
  const beforeLaunch = beforeLaunchOf(deps);
  const session = sessionOf(deps);

  // 「この PC で再開」の確認に出すもの。前の PC と最後に使った日時、この PC と読み替えた作業ディレクトリ、手元のトランスクリプトを置き換えるかを返す（runs/handover.ts）。
  api.get('/sessions/:id/resume-here', (c) => {
    const plan = resumeHerePlan(deps.db, deps.deviceId, c.req.param('id'), { replace: deps.resumeHereReplace, now: Date.now() });
    return plan ? c.json(plan) : c.json({ error: tr('session.error.notFound') }, 404);
  });

  // 他端末の本文を手元に写してから再開する。手元の方が小さいときだけ 409 で確認を求める。
  api.post('/sessions/:id/resume-here', async (c) => {
    const b = await readJson(c, BODY_LIMITS.default);
    if (b.tooLarge) return tooLargeResult(c, BODY_LIMITS.default, tr);
    const body = (b.value ?? {}) as { overwrite?: unknown };
    const id = c.req.param('id');
    // 生きたロックのある会話は、頼まずには引き継げない（sync/takeover.ts）。頼みを運べないまま force で進めた分は、行が無いのでメモリの印で通す。
    const gate = resumeHereAllowed(deps.db, deps.deviceId, id, Date.now());
    if (!gate.ok) {
      const lock = sessionLock(deps.db, deps.deviceId, id, Date.now());
      if (!lock || !deps.takeover.forcedWithoutRow(id, lock.runId)) {
        const locked: TakeoverLockedDto = { error: tr('sync.takeover.locked', { device: gate.deviceName }), code: 'locked' };
        return c.json(locked, 409);
      }
    }
    try {
      const r = await deps.resumeHere(id, body.overwrite === true);
      return 'error' in r ? c.json(r, 409) : c.json(r);
    } catch (e) {
      if (e instanceof RunError) return c.json({ error: errorText(language(), e) }, e.status);
      throw e;
    }
  });

  // 引き継ぎ。ほかの PC で動く会話を止めてもらい、最後の本文が降りるのを待つ。段の変化は takeover.update で配る。
  const hasSession = (id: string): boolean => deps.db.prepare('select 1 from sessions where id = ?').get(id) !== undefined;
  api.post('/sessions/:id/takeover', async (c) => {
    const id = c.req.param('id');
    const b = await readJson(c, BODY_LIMITS.default);
    if (b.tooLarge) return tooLargeResult(c, BODY_LIMITS.default, tr);
    const force = ((b.value ?? {}) as { force?: unknown }).force;
    if (force !== undefined && typeof force !== 'boolean') return c.json({ error: tr('http.request.badShape') }, 400);
    if (!hasSession(id)) return c.json({ error: tr('session.error.notFound') }, 404);
    // 頼むと相手の会話は停止する。この PC で起こせない（tmux や psmux、会話のエージェントの claude か opencode が無い）なら、頼む前に起動と同じ理由で断る。
    try {
      deps.runs.assertCanStart(id);
    } catch (e) {
      if (e instanceof RunError) return c.json({ error: errorText(language(), e) }, e.status);
      throw e;
    }
    return c.json(deps.takeover.start(id, { force: force === true }));
  });
  api.get('/sessions/:id/takeover', (c) => {
    const t = deps.takeover.get(c.req.param('id'));
    return t ? c.json(t) : c.json({ error: tr('session.error.notFound') }, 404);
  });
  api.post('/sessions/:id/takeover/extend', (c) => {
    const t = deps.takeover.extend(c.req.param('id'));
    return t ? c.json(t) : c.json({ error: tr('session.error.notFound') }, 404);
  });
  api.delete('/sessions/:id/takeover', (c) => {
    deps.takeover.cancel(c.req.param('id'));
    return c.body(null, 204);
  });

  // 中断の群の「再開しない」（dismissed が真）と、その取り消し（偽）。新しい群を返し、画面へも配る。
  api.post('/interrupted/dismiss', async (c) => {
    const b = await readJson(c, BODY_LIMITS.default);
    if (b.tooLarge) return tooLargeResult(c, BODY_LIMITS.default, tr);
    const body = (b.value ?? {}) as { runIds?: unknown; dismissed?: unknown };
    const ids = body.runIds;
    if (!Array.isArray(ids) || !ids.every((x): x is string => typeof x === 'string') || typeof body.dismissed !== 'boolean') return c.json({ error: tr('http.request.badShape') }, 400);
    setInterruptedDismissed(deps.db, ids, body.dismissed, Date.now());
    const interrupted = interruptedGroup(deps.db);
    deps.hub.broadcast({ type: 'interrupted.update', interrupted });
    return c.json({ interrupted });
  });

  api.get('/runs', (c) => c.json(deps.runs.listAlive()));
  api.post('/runs', async (c) => {
    const b = await readJson(c, BODY_LIMITS.default);
    if (b.tooLarge) return tooLargeResult(c, BODY_LIMITS.default, tr);
    const params = (b.value ?? null) as LaunchParams | null;
    if (!params || typeof params !== 'object') return c.json({ error: tr('http.request.notJson') }, 400);
    // 他端末の最新を先に取り込む。間に合わなくても起動する（結果は見ない）。
    await beforeLaunch();
    // opencode の起動は serve と会話の下ごしらえ（materialize）を待つので、応答まで数秒かかることがある。
    return runResultAsync(c, language, () => deps.runs.start(params), 201);
  });
  // ターミナルの包み方（~/.agent-hangar/shell/claude.zsh）からの起動。断ったら、包み方は素の claude（opencode）を起動する。
  // 本文の agent が opencode なら opencode の口へ渡す。agent の無い本文（claude の包み、古い包み方）は Claude Code にする。
  api.post('/runs/terminal', async (c) => {
    const b = await readJson(c, BODY_LIMITS.terminal);
    if (b.tooLarge) return tooLargeResult(c, BODY_LIMITS.terminal, tr);
    const req = decodeTerminalRequest(b.value);
    const agent = terminalAgentOf(b.value);
    if (!req || !agent) return c.json({ error: tr('http.request.badShape') }, 400);
    await beforeLaunch();
    // opencode は serve と会話の下ごしらえ（materialize）を待つので、非同期の口で受ける。
    if (agent === 'opencode') return runResultAsync(c, language, () => deps.runs.startOpencodeFromTerminal(req), 201);
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
    // Windows のタブや窓の題名にするセッション名。シェルタブは、どのタブかが分かるよう名前の後ろにタブの題名を添える。
    const name = session(run.sessionId)?.name;
    const title = name ? (t.kind === 'shell' ? `${name} (${t.title})` : name) : undefined;
    return external(c, () => deps.external.openTerminal({ tmuxName: t.tmuxName, title }));
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
  // 再開。hangar では終わった扱いの run の claude が動き続けていれば、pid を添えた 409（code: stray_process）で断る。
  // 画面は確認を出し、利用者の選び方を stray（stop は止めてから、ignore は止めずに）で送り直す。
  api.post('/sessions/:id/resume', async (c) => {
    const b = await readJson(c, BODY_LIMITS.default);
    if (b.tooLarge) return tooLargeResult(c, BODY_LIMITS.default, tr);
    const stray = ((b.value ?? {}) as { stray?: unknown }).stray;
    if (stray !== undefined && stray !== 'stop' && stray !== 'ignore') return c.json({ error: tr('http.request.badShape') }, 400);
    await beforeLaunch();
    return runResultAsync(c, language, () => deps.runs.resumeWith(c.req.param('id'), stray ? { stray } : {}), 201);
  });
  api.post('/sessions/:id/fork', async (c) => { await beforeLaunch(); return runResult(c, language, () => deps.runs.fork(c.req.param('id')), 201); });
  // バックグラウンドのサービスが持つセッションに、hangar の tmux からつなぐ。本文はその claude が書くので、他端末の取り込みは待たない。
  api.post('/sessions/:id/attach', (c) => runResult(c, language, () => deps.runs.attach(c.req.param('id')), 201));
  // hangar の外のターミナルで動く claude を止め、バックグラウンドに移してからつなぐ。
  api.post('/sessions/:id/adopt', (c) => runResultAsync(c, language, () => deps.runs.adopt(c.req.param('id')), 201));
}
