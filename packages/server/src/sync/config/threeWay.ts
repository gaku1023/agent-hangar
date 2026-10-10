import type { ConfigInboxOp } from '@agent-hangar/shared';

/**
 * 3 方向の判定（設定の同期の設計書の 3 章）。
 * 項目ごとに、手元（自分）、相手の束、前回の共通（config_base）の 3 つの指紋を比べ、何をするかを決める。
 * 純粋な関数で、ファイルも DB も触らない。
 *
 * | 手元 | 相手 | 前回の共通 | 結果 |
 * |---|---|---|---|
 * | あり | なし | なし | 手元だけ。送るだけで何も受けない |
 * | なし | あり | なし | create |
 * | 同じ | 同じ | - | 何もしない。共通の中身として覚える |
 * | 前回と同じ | 違う | あり | overwrite（相手だけが変えた） |
 * | 前回と違う | 前回と同じ | あり | 何もしない（手元が新しい。送るだけ） |
 * | 前回と違う | 前回と違う | - | conflict |
 * | 前回と同じ | なし | あり | delete（相手が消した） |
 * | 前回と違う | なし | あり | conflict（相手は消し、手元は変えた） |
 * | なし | 前回と同じ | あり | 何もしない（手元で消した。消した側が送る） |
 * | なし | 前回と違う | あり | conflict（手元は消し、相手は変えた） |
 *
 * 相手が複数いるとき、項目ごとに見るのは「その項目を持つ束のうち、いちばん新しいもの」1 つだけである。
 * 束ごとに別々に判定すると、2 台が違う版を持つときに、手元がその 2 つのあいだを行き来し続ける。
 * 項目が消えたと見なすのは、どの相手の束にもその項目が無いときだけである。
 * 1 台の束から消えても、別の相手がまだ持っているあいだは消さない（本当に消えたのか、その PC が持っていなかっただけなのかが、束からは分からない）。
 * 消した PC が 3 台のうち 1 台だけのとき、その消去は他の PC に伝わらない（安全な側に倒した割り切り）。
 */

export type RemoteSnapshot = {
  deviceId: string;
  /** 束を上げた時刻（config_snapshots.updated_at）。新しい方を採る。 */
  at: number;
  items: ReadonlyMap<string, { sha256: string }>;
};

export type Action = {
  id: string;
  op: ConfigInboxOp;
  /** 採る側（または消した側）の PC。 */
  fromDeviceId: string;
  /** 相手の指紋。相手が消した項目は null。 */
  remoteSha256: string | null;
  /** 手元の指紋。手元に無ければ null。 */
  localSha256: string | null;
};

export type Judgement = {
  actions: Action[];
  /** 手元と相手が同じだった項目。共通の中身として config_base に書く。 */
  agreed: Map<string, string>;
  /** どこにも無くなった項目。config_base の行を消す。 */
  forget: string[];
};

/** 新しい束を前にする。同じ新しさなら端末 ID の大きい方を前にする。 */
const newerFirst = (a: RemoteSnapshot, b: RemoteSnapshot): number => b.at - a.at || (a.deviceId < b.deviceId ? 1 : a.deviceId > b.deviceId ? -1 : 0);

export function judge(i: { local: ReadonlyMap<string, string>; base: ReadonlyMap<string, string>; remotes: readonly RemoteSnapshot[] }): Judgement {
  const out: Judgement = { actions: [], agreed: new Map(), forget: [] };
  if (i.remotes.length === 0) return out;
  const remotes = [...i.remotes].sort(newerFirst);
  const newest = remotes[0]!;
  const ids = new Set<string>([...i.local.keys(), ...i.base.keys()]);
  for (const r of remotes) for (const id of r.items.keys()) ids.add(id);

  for (const id of [...ids].sort()) {
    const l = i.local.get(id) ?? null;
    const b = i.base.get(id) ?? null;
    const holder = remotes.find((r) => r.items.has(id));
    const rsha = holder ? holder.items.get(id)!.sha256 : null;

    if (!holder) {
      if (l === null) { if (b !== null) out.forget.push(id); continue; }
      if (b === null) continue; // 手元だけ
      out.actions.push({ id, op: l === b ? 'delete' : 'conflict', fromDeviceId: newest.deviceId, remoteSha256: null, localSha256: l });
      continue;
    }
    const from = holder.deviceId;
    if (l === rsha) { out.agreed.set(id, l!); continue; }
    if (l === null) {
      if (b === null) out.actions.push({ id, op: 'create', fromDeviceId: from, remoteSha256: rsha, localSha256: null });
      else if (b !== rsha) out.actions.push({ id, op: 'conflict', fromDeviceId: from, remoteSha256: rsha, localSha256: null });
      continue; // b === rsha は、手元で消したもの
    }
    if (b === l) out.actions.push({ id, op: 'overwrite', fromDeviceId: from, remoteSha256: rsha, localSha256: l });
    else if (b !== rsha) out.actions.push({ id, op: 'conflict', fromDeviceId: from, remoteSha256: rsha, localSha256: l });
    // b === rsha で l が違うときは、手元が新しい。
  }
  return out;
}
