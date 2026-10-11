import { DEVICE_ADMIN_MIN_WORKER_COMPAT, type CloudDevicesDto, type Language } from '@agent-hangar/shared';
import { errorText, msg, render } from '../i18n/message.ts';
import { CloudError, RevokedError, type CloudClient } from './client.ts';

export type CloudDevicesDeps = {
  client: Pick<CloudClient, 'listDevices' | 'lastWorkerCompat'> | null;
  deviceId: string;
  /** この PC がクラウドを作った PC か（cloud.json に Worker の名前がある）。 */
  creator: boolean;
  language: () => Language;
};

/**
 * 設定のクラウド同期の節に出す PC の一覧を、Worker から取る。
 * 一覧の正は Worker の devices で、参加日、解除日、最後に同期した IP と場所はそこにしか無い。
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
    const rows = await d.client.listDevices();
    return { state: 'ok', devices: rows.map((r) => ({ ...r, self: r.id === d.deviceId })), creator: d.creator, message: null };
  } catch (e) {
    if (e instanceof RevokedError) return { state: 'revoked', ...empty, message: errorText(d.language(), e) };
    // 経路の無い古い Worker。版の見出しで見分けられなかったとき（まだ話していなかった）の受け口である。
    if (e instanceof CloudError && e.status === 404) return outdated();
    return { state: 'unreachable', ...empty, message: errorText(d.language(), e) };
  }
}
