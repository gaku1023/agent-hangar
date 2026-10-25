import { DEVICE_ADMIN_MIN_WORKER_COMPAT, type CloudDevicesDto, type Language, type RosterEntry } from '@agent-hangar/shared';
import type { Db } from '../db/open.ts';
import { errorText, msg, render } from '../i18n/message.ts';
import { CloudError, RevokedError, type CloudClient } from './client.ts';
import type { RosterStore } from './roster.ts';

export type CloudDevicesDeps = {
  client: Pick<CloudClient, 'listDevices' | 'lastWorkerCompat'> | null;
  /**
   * 封じた名簿。名前と OS はここにしか無い。null なら名前なしで出す。
   * 一覧を読むたびに invalidate してから読む。一時停止の間は印の行を受けないので、写しが古いままになりうるからである。
   */
  roster: (Pick<RosterStore, 'read'> & Partial<Pick<RosterStore, 'invalidate'>>) | null;
  deviceId: string;
  /** この PC がクラウドを作った PC か（cloud.json に Worker の名前がある）。 */
  creator: boolean;
  language: () => Language;
  /**
   * 名簿にあるのに Worker で解除済みのスマホ（スマホが自分で外した）を見つけたら、その ID を渡す。
   * 受け手（leftPhoneSweeper）は、PC からの解除と同じく名簿から外して M を回す。
   * 一覧と名簿の両方が読めたときだけ呼び、見つからなければ呼ばない。
   */
  onLeftPhones?: (ids: string[]) => void;
  /**
   * 共有テーブルの devices の行（PC の名前と OS）を ID で引く。行が無ければ null。
   * 解除した PC は名簿から外れるので、解除済みの行の名前はここから取る（sharedDeviceOf）。渡さなければ名前なしで出す。
   */
  sharedDevice?: (id: string) => { name: string; platform: string } | null;
};

/**
 * 共有テーブルの devices から PC の名前と OS を引く口。
 * 消した印（deleted_at）の付いた行も読む。解除した PC の名前を残すための控えで、生きているかは Worker の一覧で決める。
 */
export function sharedDeviceOf(db: Db): (id: string) => { name: string; platform: string } | null {
  return (id) => {
    const r = db.prepare('select name, platform from devices where id = ?').get(id) as { name: string; platform: string } | undefined;
    return r ?? null;
  };
}

/** 名簿の行を ID で引く。名簿が読めなければ空で、一覧は名前なしで出す（一覧そのものは Worker から取れている）。 */
async function rosterEntries(roster: CloudDevicesDeps['roster']): Promise<Map<string, RosterEntry>> {
  if (!roster) return new Map();
  try {
    roster.invalidate?.();
    return new Map((await roster.read()).roster.entries.map((e) => [e.id, e]));
  } catch {
    return new Map();
  }
}

/** 解除した PC の名前の控え。読めなければ null（一覧は名前なしで出す）。 */
function keptName(d: CloudDevicesDeps, id: string): { name: string; platform: string } | null {
  try { return d.sharedDevice?.(id) ?? null; } catch { return null; }
}

/**
 * 設定のクラウド同期の節に出す端末の一覧を組む。
 * 並びと、参加日、最終接続、解除日、トークンの期限は Worker の devices から取り、名前と OS は封じた名簿から ID で突き合わせる。
 * Worker にあって名簿に無い端末は、名前のわからない端末（name と platform が null）として出す。
 * ただし解除した PC は、名簿から外れても共有の devices に名前が残っていれば、その名前と OS で出す（sharedDevice）。
 * 名簿にあって Worker に無い端末は出さない（認証できる端末の正は Worker である）。
 * 共有テーブルの devices（シェル連携の状態とロックの端末名）とは別に取る。
 * 一時停止の間も取りに行く。設定を開いたときの 1 回だけで、D1 は読むだけである。
 */
export async function loadCloudDevices(d: CloudDevicesDeps): Promise<CloudDevicesDto> {
  const empty = { devices: [], creator: d.creator };
  if (!d.client?.listDevices) return { state: 'off', ...empty, creator: false, message: null };
  const outdated = (): CloudDevicesDto => ({ state: 'outdated', ...empty, message: render(d.language(), msg('sync.devices.workerOutdated')) });
  // 版を名乗った Worker が足りなければ、404 を待たずに案内する。まだ話していなければ（null）試す。
  const seen = d.client.lastWorkerCompat?.() ?? null;
  if (seen !== null && seen < DEVICE_ADMIN_MIN_WORKER_COMPAT) return outdated();
  try {
    const [rows, entries] = await Promise.all([d.client.listDevices(), rosterEntries(d.roster)]);
    const devices = rows.map((r) => {
      const e = entries.get(r.id);
      // 解除した PC は名簿から外れるので、共有の devices に残る名前で出す。解除していない名前のわからない端末（参加し直した PC の古い ID など）は今どおり名前なし。
      const kept = !e && r.kind === 'pc' && r.revokedAt !== null ? keptName(d, r.id) : null;
      return { id: r.id, kind: r.kind, name: e?.name ?? kept?.name ?? null, platform: e?.os ?? kept?.platform ?? null, joinedAt: r.joinedAt, lastSeenAt: r.lastSeenAt, revokedAt: r.revokedAt, expiresAt: r.expiresAt, self: r.id === d.deviceId };
    });
    const left = rows.filter((r) => r.kind === 'mobile' && r.revokedAt !== null && entries.get(r.id)?.kind === 'phone').map((r) => r.id);
    if (left.length > 0) {
      try { d.onLeftPhones?.(left); } catch (e) { console.error('[sync] could not start removing the phones that left', e instanceof Error ? e.constructor.name : typeof e); }
    }
    return { state: 'ok', devices, creator: d.creator, message: null };
  } catch (e) {
    if (e instanceof RevokedError) return { state: 'revoked', ...empty, message: errorText(d.language(), e) };
    // 経路の無い古い Worker。版の見出しで見分けられなかったとき（まだ話していなかった）の受け口である。
    if (e instanceof CloudError && e.status === 404) return outdated();
    return { state: 'unreachable', ...empty, message: errorText(d.language(), e) };
  }
}

/**
 * スマホが自分で外した（`POST /m/leave`）後の後始末（設計書「スマホの解除」）。
 * Worker はそのスマホの行に解除日を付けるが、名簿からは外さず、スマホ用の鍵 M も回さない。
 * 盗まれたスマホで外されると、PC の設定の表から消えたまま名簿に残り、M も前の世代のままになる。
 * そこで、端末の一覧を読んだ PC が見つけたスマホを、PC からの解除と同じ口（rotate.ts の revokeMember）へ渡し、名簿から外して M を回す。
 * 新しい問い合わせは足さない。見つけるのは、もともと読んでいる一覧（loadCloudDevices）である。
 * 後始末の最中のスマホは重ねて渡さない。失敗は知らせるだけで投げず、次に一覧を読んで見つけたときにもう一度渡す。
 * 複数の PC が同時に見つけても、名簿の書き換えは版の食い違いで当て直し、名簿にいないスマホでは M を回さないので、M は 1 度だけ回る。
 */
export function leftPhoneSweeper(revoke: (id: string) => Promise<unknown>): (ids: string[]) => void {
  const running = new Set<string>();
  return (ids) => {
    for (const id of ids) {
      if (running.has(id)) continue;
      running.add(id);
      void revoke(id)
        .catch((e: unknown) => { console.error('[sync] could not remove a phone that left by itself', e instanceof Error ? e.constructor.name : typeof e); })
        .finally(() => { running.delete(id); });
    }
  };
}
