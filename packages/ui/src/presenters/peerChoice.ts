import type { PeerDeviceDto } from '@agent-hangar/shared';

/**
 * 新規ダイアログの PC の選択（案 1C）の、純粋な判定。
 * 選んだ PC で使えない項目（無いアカウント、ログインしていないアカウント、置き場の無いプロジェクト、入っていないエージェント）を、
 * 選ぶ前に見分けるために使う。使えない項目は各行の末尾に集めて薄くし、選べなくする。
 */

/** 選べるか。ok は選べる、missing は相手に無い、loggedOut は相手でログインしていない。 */
export type PeerItemState = 'ok' | 'missing' | 'loggedOut';

/** PC の印。頼める PC は印を持たない。offline はいま接続できない、outdated は hangar が古い。 */
export function peerMark(p: PeerDeviceDto): 'offline' | 'outdated' | null {
  return p.state === 'ready' ? null : p.state;
}

/** プロジェクトが相手で選べるか。クイックセッション（null）は場所を持たないので常に ok。 */
export function peerProjectState(p: PeerDeviceDto, projectId: string | null): PeerItemState {
  return projectId === null || p.projects.includes(projectId) ? 'ok' : 'missing';
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
 * アカウントの札の値（名前）。選んだ名前が選べればそれ。選べなければ、この PC のいまのアカウントと同じ名前（D7）、それも選べなければ選べる最初。
 * 選べるものが無ければ null で、アカウントを指定せず、相手の既定に任せる。
 */
export function peerAccountPick(rows: PeerAccountRow[], picked: string | null, currentName: string | null): string | null {
  const ok = (n: string | null) => (n !== null && rows.some((r) => r.name === n && r.state === 'ok') ? n : null);
  return ok(picked) ?? ok(currentName) ?? rows.find((r) => r.state === 'ok')?.name ?? null;
}
