import type { PeerDeviceDto } from '@agent-hangar/shared';

/**
 * 新規ダイアログの PC の選択（案 1C）の、純粋な判定。
 * 選んだ PC で使えない項目（無いアカウント、ログインしていないアカウント、置き場の無いプロジェクト、入っていないエージェント）を、
 * 選ぶ前に見分けるために使う。使えない項目は各行の末尾に集めて薄くし、選べなくする。
 */

/** 選べるか。ok は選べる、missing は相手に無い、loggedOut は相手でログインしていない。 */
export type PeerItemState = 'ok' | 'missing' | 'loggedOut';

/** PC の印。頼める PC は印を持たない。offline はいま接続できない、outdated は hangar が古い、worker-outdated はクラウドの Worker が古い。 */
export function peerMark(p: PeerDeviceDto): 'offline' | 'outdated' | 'worker-outdated' | null {
  return p.state === 'ready' ? null : p.state;
}

/** プロジェクトが相手で選べるか。クイックセッション（null）は場所を持たないので常に ok。 */
export function peerProjectState(p: PeerDeviceDto, projectId: string | null): PeerItemState {
  return projectId === null || p.projects.includes(projectId) ? 'ok' : 'missing';
}

/**
 * ダイアログを開いたときに選んでおく PC。null はこの PC。
 * 頼める（ready で、そのプロジェクトの置き場がある）PC だけを選ぶ。頼めなければこの PC のまま（黙って別の PC に替えない）。
 * - 会話の画面から開き、その会話が別の PC で動いている、または最後に動いたのが別の PC なら、その PC（sessionDevice）。
 * - プロジェクトがこの PC に無い（here が偽）なら、置き場のある PC。会話の PC、プロジェクトの会話で最後に使った PC（projectDevices、新しい順、null は手元）、一覧の順で選ぶ。
 */
export function defaultPeerPick(o: { peers: PeerDeviceDto[]; projectId: string | null; scratch: boolean; here: boolean; sessionDevice: string | null; projectDevices: (string | null)[] }): string | null {
  const target = o.scratch ? null : o.projectId;
  const usable = (id: string | null) => o.peers.find((p) => p.id === id && p.state === 'ready' && peerProjectState(p, target) === 'ok')?.id ?? null;
  const fromSession = usable(o.sessionDevice);
  if (fromSession) return fromSession;
  if (o.scratch || o.projectId === null || o.here) return null;
  for (const d of o.projectDevices) {
    const id = usable(d);
    if (id) return id;
  }
  return o.peers.map((p) => usable(p.id)).find((id) => id !== null) ?? null;
}

export function peerAgentState(p: PeerDeviceDto, agent: string): PeerItemState {
  return p.agents.includes(agent) ? 'ok' : 'missing';
}

/** アカウントの札の 1 行。localId はこの PC に同じ名前があるときのその id（無ければ null）。 */
export type PeerAccountRow = { name: string; state: PeerItemState; localId: string | null };

/**
 * 選んだ PC のアカウントの一覧。この PC のアカウントと相手のアカウントを、エージェントを合わせたうえで名前で突き合わせる。
 * 相手で選べるもの（ok）を先に、相手に無いもの（missing）、ログアウト中のもの（loggedOut）を末尾へ集める。同じ区分の中の並びは、この PC、相手の順。
 * opencode はアカウントを持たないので空。
 */
export function peerAccountOptions(p: PeerDeviceDto, agent: string, local: { name: string; id: string }[]): PeerAccountRow[] {
  if (agent === 'opencode') return [];
  const theirs = p.accounts.filter((a) => a.agent === agent);
  const rows: PeerAccountRow[] = local.map((l) => {
    const t = theirs.find((a) => a.name === l.name);
    return { name: l.name, localId: l.id, state: !t ? 'missing' : t.loggedIn === false ? 'loggedOut' : 'ok' };
  });
  for (const t of theirs) if (!local.some((l) => l.name === t.name)) rows.push({ name: t.name, localId: null, state: t.loggedIn === false ? 'loggedOut' : 'ok' });
  const rank: Record<PeerItemState, number> = { ok: 0, missing: 1, loggedOut: 2 };
  return rows.map((r, i) => ({ r, i })).sort((a, b) => rank[a.r.state] - rank[b.r.state] || a.i - b.i).map((x) => x.r);
}

/**
 * アカウントの札の値（名前）。選んだ名前、無ければこの PC のいまのアカウントと同じ名前（D7）、それも一覧に無ければ選べる最初。
 * 選べない名前（相手に無い、ログアウト中）でも、一覧にあればそのまま返す。黙って別のものへ移さず、呼び手が起動を止める。
 * 一覧に名前が無く、選べるものも無ければ null で、アカウントを指定せず、相手の既定に任せる。
 */
export function peerAccountPick(rows: PeerAccountRow[], picked: string | null, currentName: string | null): string | null {
  const has = (n: string | null) => (n !== null && rows.some((r) => r.name === n) ? n : null);
  return has(picked) ?? has(currentName) ?? rows.find((r) => r.state === 'ok')?.name ?? null;
}
