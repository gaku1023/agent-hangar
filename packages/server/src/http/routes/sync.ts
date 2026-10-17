import type { Context } from 'hono';
import type { Hono } from 'hono';
import { errorText, translatorOf } from '../../i18n/message.ts';
import { deriveMobileKeyBytes, encodePairing, MOBILE_MIN_WORKER_COMPAT, type MobilePairingDto } from '@agent-hangar/shared';
import { CloudError, CompatError, LimitError, RevokedError } from '../../sync/client.ts';
import { ConfigSyncError } from '../../sync/config/service.ts';
import { JoinStateError } from '../../sync/joinApprover.ts';
import { RecoveryDraftError } from '../../sync/recoveryReissue.ts';
import { RevokeNotFoundError, RevokeSelfError } from '../../sync/rotate.ts';
import type { AppDeps, JoinApproverApi, LanguageDeps, RecoveryKeyApi } from '../deps.ts';
import { BODY_LIMITS, readJson, syncStatusOf, tooLargeResult } from './common.ts';

/** 同期の経路が使う依存。 */
export type SyncRouteDeps = Pick<AppDeps, 'sync' | 'syncSkipped' | 'syncSweep' | 'syncOncePass' | 'cloudUsage' | 'devices' | 'cloudDevices' | 'cloudRevoke' | 'mobileLink' | 'deviceName' | 'joinApprover' | 'recoveryKey' | 'configBundle'> & LanguageDeps;

/**
 * 端末の解除の失敗を、符号と HTTP の状態にする。CLI の hangar cloud revoke はこの符号を読む。
 * self は自分自身、not-found は Worker の一覧に無い端末、revoked はこの PC が解除されている、unreachable はそのほか（Worker に届かないなど）。
 */
function revokeFailure(e: unknown): { code: 'self' | 'not-found' | 'revoked' | 'unreachable'; status: 409 | 404 | 502 } {
  if (e instanceof RevokeSelfError) return { code: 'self', status: 409 };
  if (e instanceof RevokeNotFoundError) return { code: 'not-found', status: 404 };
  if (e instanceof RevokedError) return { code: 'revoked', status: 409 };
  return { code: 'unreachable', status: 502 };
}

/**
 * スマホを接続する QR を作る。押すたびに Worker から新しい券を取る（GET にしない）。
 * Worker の版がまだ分からなければ /health で確かめ、MOBILE_MIN_WORKER_COMPAT に届かなければ券を取りに行かない。
 * 版を知らない古い Worker の 404 も worker-too-old に読む。券の取りすぎの 429 は rate-limited（Cloudflare の上限の LimitError はそのまま投げる）。
 * pairText にはスマホ用の暗号鍵（参加の秘密から導いた 32 バイト）が入る。参加の秘密そのものは入れず、ログにも出さない。
 */
async function mobilePairing(deps: SyncRouteDeps): Promise<MobilePairingDto> {
  const link = deps.mobileLink?.() ?? null;
  if (!link) return { state: 'not-joined' };
  const { client } = link;
  const compatOf = () => client.lastWorkerCompat?.() ?? null;
  if (compatOf() === null) await client.health().catch(() => undefined);
  const compat = compatOf();
  if ((compat !== null && compat < MOBILE_MIN_WORKER_COMPAT) || !client.createPairing) return { state: 'worker-too-old', compat };
  let ticket: { code: string; expiresAt: number };
  try {
    ticket = await client.createPairing();
  } catch (e) {
    if (e instanceof CloudError && !(e instanceof LimitError) && e.status === 429) return { state: 'rate-limited' };
    if (e instanceof CloudError && e.status === 404) return { state: 'worker-too-old', compat: compatOf() };
    if (e instanceof CompatError && e.upgrade === 'worker') return { state: 'worker-too-old', compat: e.have };
    throw e;
  }
  const key = Buffer.from(await deriveMobileKeyBytes(link.joinSecret)).toString('base64url');
  const url = link.url.replace(/\/+$/, '');
  const pairText = encodePairing({ url, code: ticket.code, key, pcName: deps.deviceName, expiresAt: ticket.expiresAt });
  return { state: 'ready', pairUrl: `${url}/app/#pair=${pairText}`, pairText, expiresAt: ticket.expiresAt };
}

/** 同期の経路。状態、今すぐ同期、一時停止、前面化、使用量、端末の一覧、参加コードの発行と承認、設定の同期（/config-sync/*）を持つ。 */
export function syncRoutes(api: Hono, deps: SyncRouteDeps): void {
  const tr = translatorOf(deps.language);
  const syncStatus = syncStatusOf(deps);

  // 同期。どれも既存の authMiddleware の下にあり、鍵付きの入口と 3 つの検査を通る。
  api.get('/sync/status', (c) => c.json(syncStatus()));
  api.post('/sync/now', async (c) => { await deps.sync.syncNow(); return c.json(syncStatus()); });
  api.post('/sync/pause', async (c) => {
    const b = await readJson(c, BODY_LIMITS.default);
    if (b.tooLarge) return tooLargeResult(c, BODY_LIMITS.default, tr);
    const body = (b.value ?? {}) as { paused?: unknown };
    if (typeof body.paused !== 'boolean') return c.json({ error: tr('common.field.mustBeBoolean', { field: 'paused' }) }, 400);
    deps.sync.setPaused(body.paused);
    // 再開は pull を投げっぱなしにするので、直後のこの状態は pulling になりうる。
    return c.json(syncStatus());
  });
  // 前面化は待たせない。間引き（前の pull から 5 秒）は SyncEngine.onFocus の中にある。
  api.post('/sync/focus', (c) => { void deps.sync.onFocus().catch(() => {}); return c.body(null, 202); });
  // 設定を開いたときは refresh=1 で取り直す。一時停止の間は取りに行かず、最後の値を返す（CloudUsagePoller が守る）。
  api.get('/sync/usage', async (c) => c.json(c.req.query('refresh') === '1' ? await deps.cloudUsage.refresh() : deps.cloudUsage.current()));
  api.get('/devices', (c) => c.json(deps.devices()));
  // Worker の devices（参加日、最終接続、解除日）と、名簿の名前と OS。
  api.get('/sync/cloud-devices', async (c) => c.json(await deps.cloudDevices()));
  // 他の端末の解除。PC なら世代を回す（sync/rotate.ts）。回しの途中の記録と世代鍵は動いているサーバーにあるので、CLI もここを呼ぶ。
  api.post('/sync/cloud-devices/:id/revoke', async (c) => {
    c.header('cache-control', 'no-store');
    const revoke = deps.cloudRevoke?.() ?? null;
    if (!revoke) return c.json({ error: tr('sync.error.notConfigured'), code: 'not-joined' }, 404);
    try {
      return c.json({ device: await revoke(c.req.param('id')) });
    } catch (e) {
      const f = revokeFailure(e);
      if (f.code === 'unreachable') console.error('[rotate] could not remove the device', e instanceof Error ? e.constructor.name : typeof e);
      return c.json({ error: errorText(deps.language(), e), code: f.code }, f.status);
    }
  });
  // 参加コードの発行と承認（設定のクラウド同期の「PC を追加」）。
  // 応答は JoinApproverState で、参加コードの平文が載るので no-store を付ける。
  const join = async (c: Context, fn: (a: JoinApproverApi) => unknown | Promise<unknown>, status: 200 | 201 = 200) => {
    c.header('cache-control', 'no-store');
    const a = deps.joinApprover();
    if (!a) return c.json({ error: tr('sync.error.notConfigured') }, 404);
    try {
      await fn(a);
    } catch (e) {
      if (e instanceof JoinStateError) return c.json({ error: errorText(deps.language(), e) }, 409);
      if (e instanceof CloudError && !(e instanceof LimitError) && e.status === 429) return c.json({ error: tr('sync.join.rateLimited') }, 429);
      return c.json({ error: errorText(deps.language(), e) }, 502);
    }
    return c.json(a.state(), status);
  };
  api.post('/sync/join-codes', (c) => join(c, (a) => a.issue(), 201));
  api.get('/sync/join-codes/current', (c) => join(c, () => undefined));
  api.post('/sync/join-codes/current/approve', (c) => join(c, (a) => a.approve()));
  api.post('/sync/join-codes/current/reject', (c) => join(c, (a) => a.reject()));
  api.delete('/sync/join-codes/current', (c) => join(c, (a) => a.cancel()));
  // リカバリーキーの再発行（設定のクラウド同期の「リカバリーキーを再発行」）。
  // 再発行の応答にはリカバリーキーの秘密鍵が載るので no-store を付け、ログにも出さない。
  // 確認の末尾 4 文字が違えば 400、下書きが無いか名簿がまだ無ければ 409、Worker の失敗は 502 にする。
  const recovery = async (c: Context, fn: (r: RecoveryKeyApi) => Promise<unknown>) => {
    c.header('cache-control', 'no-store');
    const r = deps.recoveryKey();
    if (!r) return c.json({ error: tr('sync.error.notConfigured') }, 404);
    try {
      return c.json(await fn(r) as object);
    } catch (e) {
      if (e instanceof RecoveryDraftError) return c.json({ error: errorText(deps.language(), e) }, e.reason === 'tail-mismatch' ? 400 : 409);
      return c.json({ error: errorText(deps.language(), e) }, 502);
    }
  };
  api.post('/sync/recovery-key/reissue', (c) => recovery(c, (r) => r.reissue()));
  api.post('/sync/recovery-key/confirm', async (c) => {
    const b = await readJson(c, BODY_LIMITS.default);
    if (b.tooLarge) return tooLargeResult(c, BODY_LIMITS.default, tr);
    const body = (b.value ?? {}) as { draftId?: unknown; tail?: unknown };
    for (const field of ['draftId', 'tail'] as const) {
      if (typeof body[field] !== 'string') return c.json({ error: tr('common.field.mustBeString', { field }) }, 400);
    }
    return recovery(c, async (r) => {
      await r.confirm(body.draftId as string, body.tail as string);
      return { ok: true };
    });
  });
  // スマホを接続する QR。中身にスマホ用の暗号鍵が入るので、残さないよう no-store を付ける。失敗の理由は文にして返し、中身はログに出さない。
  api.post('/sync/mobile-pairing', async (c) => {
    c.header('cache-control', 'no-store');
    try {
      return c.json(await mobilePairing(deps));
    } catch (e) {
      return c.json({ error: errorText(deps.language(), e) }, 502);
    }
  });

  // 設定の同期。~/.claude に書く操作は持たない。
  // 書くのは hangar の置き場の「適用の指示書」だけで、適用は殻の命令と hangar config apply が行う。
  const bundle = async (c: Context, fn: (api: NonNullable<typeof deps.configBundle>) => unknown | Promise<unknown>, empty = false) => {
    const api = deps.configBundle;
    if (!api) return c.json({ error: tr('sync.error.notConfigured') }, 404);
    try {
      const r = await fn(api);
      return empty ? c.body(null, 204) : c.json(r as object | null);
    } catch (e) {
      if (e instanceof ConfigSyncError) return c.json({ error: errorText(deps.language(), e) }, e.status);
      throw e;
    }
  };
  api.get('/config-sync', (c) => bundle(c, (b) => b.dto()));
  api.get('/config-sync/outgoing', (c) => bundle(c, (b) => b.outgoing()));
  api.get('/config-sync/inbox', (c) => bundle(c, (b) => b.inbox()));
  api.get('/config-sync/conflicts', (c) => bundle(c, (b) => b.conflicts()));
  api.get('/config-sync/unsent', (c) => bundle(c, (b) => b.unsent()));
  // 送るのは自分のクラウドへの送信で、~/.claude には書かないので HTTP に載せてよい。
  api.post('/config-sync/unsent/:id/send', (c) => bundle(c, (b) => b.sendUnsent(c.req.param('id'))));
  api.get('/config-sync/backups', (c) => bundle(c, (b) => b.backups()));
  api.get('/config-sync/apply-order', (c) => bundle(c, (b) => b.applyOrder()));
  api.put('/config-sync/apply-order', async (c) => {
    if (!deps.configBundle) return c.json({ error: tr('sync.error.notConfigured') }, 404);
    const b = await readJson(c, BODY_LIMITS.configOrder);
    if (b.tooLarge) return tooLargeResult(c, BODY_LIMITS.configOrder, tr);
    const items = (b.value as { items?: unknown } | undefined)?.items;
    if (!Array.isArray(items)) return c.json({ error: tr('configSync.error.badBody') }, 400);
    return bundle(c, (api) => api.putApplyOrder(items as Parameters<typeof api.putApplyOrder>[0]));
  });
  api.delete('/config-sync/apply-order', (c) => bundle(c, (b) => b.deleteApplyOrder(), true));
}
