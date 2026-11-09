import type { CloudClientBase } from '../sync/client.ts';

/**
 * Worker の受け箱の口（#563）。
 * 4 つとも持つ client だけを InboxApi として取り出す。
 * 口を持たない client（互換の版 12 より前の偽物など）には null を返し、呼び手は「受け箱が使えない」と読む。
 * 版が古い Worker は、口があっても 404 を返す。
 * それは呼び手が CloudError(404) で受ける。
 */
export type InboxApi = Required<Pick<CloudClientBase, 'createInbox' | 'deleteInbox' | 'pendingParcels' | 'ackParcels'>>;

export function inboxApiOf(client: CloudClientBase | null | undefined): InboxApi | null {
  if (!client?.createInbox || !client.deleteInbox || !client.pendingParcels || !client.ackParcels) return null;
  const c = client;
  return {
    createInbox: (publicKey) => c.createInbox!(publicKey),
    deleteInbox: (inboxId) => c.deleteInbox!(inboxId),
    pendingParcels: () => c.pendingParcels!(),
    ackParcels: (ids) => c.ackParcels!(ids),
  };
}
