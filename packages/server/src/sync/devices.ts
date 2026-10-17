import { DEVICE_ADMIN_MIN_WORKER_COMPAT, type CloudDevicesDto, type Language, type RosterEntry } from '@agent-hangar/shared';
import { errorText, msg, render } from '../i18n/message.ts';
import { CloudError, RevokedError, type CloudClient } from './client.ts';
import type { RosterStore } from './roster.ts';

export type CloudDevicesDeps = {
  client: Pick<CloudClient, 'listDevices' | 'lastWorkerCompat'> | null;
  /** 封じた名簿。名前と OS はここにしか無い。null なら名前なしで出す。 */
  roster: Pick<RosterStore, 'read'> | null;
  deviceId: string;
  /** この PC がクラウドを作った PC か（cloud.json に Worker の名前がある）。 */
  creator: boolean;
  language: () => Language;
};

/** 名簿の行を ID で引く。名簿が読めなければ空で、一覧は名前なしで出す（一覧そのものは Worker から取れている）。 */
async function rosterEntries(roster: CloudDevicesDeps['roster']): Promise<Map<string, RosterEntry>> {
  if (!roster) return new Map();
  try {
    return new Map((await roster.read()).roster.entries.map((e) => [e.id, e]));
  } catch {
    return new Map();
  }
}

/**
 * 設定のクラウド同期の節に出す端末の一覧を組む。
 * 並びと、参加日、最終接続、解除日、トークンの期限は Worker の devices から取り、名前と OS は封じた名簿から ID で突き合わせる。
 * Worker にあって名簿に無い端末は、名前のわからない端末（name と platform が null）として出す。
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
      return { id: r.id, kind: r.kind, name: e?.name ?? null, platform: e?.os ?? null, joinedAt: r.joinedAt, lastSeenAt: r.lastSeenAt, revokedAt: r.revokedAt, expiresAt: r.expiresAt, self: r.id === d.deviceId };
    });
    return { state: 'ok', devices, creator: d.creator, message: null };
  } catch (e) {
    if (e instanceof RevokedError) return { state: 'revoked', ...empty, message: errorText(d.language(), e) };
    // 経路の無い古い Worker。版の見出しで見分けられなかったとき（まだ話していなかった）の受け口である。
    if (e instanceof CloudError && e.status === 404) return outdated();
    return { state: 'unreachable', ...empty, message: errorText(d.language(), e) };
  }
}
