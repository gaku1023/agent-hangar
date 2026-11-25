import { describe, expect, it } from 'vitest';
import { translator, type PeerChatItem, type PeerChatTurn, type SessionDto } from '@agent-hangar/shared';
import { emptySlice, type PeerChatSlice } from '../store/peerChat.ts';
import { initialStore, type Store } from '../store/store.ts';
import { sessionDto } from '../test/sessionDto.ts';
import { presentPeerChat, presentPeerToc } from './peerChat.ts';

const ja = translator('ja');
const NOW = Date.UTC(2026, 10, 6, 3, 0, 0);
const MAC = { deviceId: 'd-mac', deviceName: 'Mac' };
const session = (): SessionDto => (sessionDto({ name: 'x', cwd: '/w/app', startedAt: NOW - 3_600_000, lastActivityAt: NOW, hasTranscript: true, lock: { deviceId: 'd-mac', deviceName: 'Mac', runId: 'r9', heartbeatAt: NOW, stale: false } }) as SessionDto);
const item = (uuid: string): PeerChatItem => ({ uuid, at: 1, kind: 'user', text: uuid });
const turn = (uuid: string, at: number): PeerChatTurn => ({ uuid, at, text: `指示 ${uuid}\n2 行目`, tools: 2 });

function build(slice: Partial<PeerChatSlice>): Store {
  const st = initialStore();
  st.device = { id: 'me', name: 'Win' };
  st.sessions = { s1: session() };
  st.peerChat = { s1: { ...emptySlice('v1'), phase: 'live', device: MAC, status: 'busy', ...slice } };
  return st;
}
const clock = (ts: number) => new Date(ts).toISOString().slice(11, 16);

describe('別の PC の会話の目次（presentPeerToc）', () => {
  it('turnCount が無い（古い相手）ときは目次を出さない', () => {
    expect(presentPeerToc(build({ turnCount: null, turns: [turn('t1', 1)] }), 's1', ja, { clock })).toBeNull();
  });

  it('行は手元の目次の形に写る。時刻、1 行目、道具の数、押した先の uuid、数の見出し', () => {
    const at = Date.UTC(2026, 10, 6, 1, 5, 0);
    const toc = presentPeerToc(build({ turnCount: 2, turnsLoaded: true, turns: [turn('t1', at), turn('t2', at + 60_000)] }), 's1', ja, { clock })!;
    expect(toc.rows).toHaveLength(2);
    expect(toc.rows[0]).toMatchObject({ when: clock(at), text: '指示 t1\n2 行目', tools: 2, open: false, band: [] });
    expect(new Set(toc.rows.map((r) => r.seq)).size).toBe(2);
    expect(toc.uuids[toc.rows[1]!.seq]).toBe('t2');
    expect(toc.count).toEqual({ n: 2, plus: false });
    expect(toc.pending).toBe(false);
    expect(toc.hasMore).toBe(false);
  });

  it('最初の答えが来る前は仮の行（pending）、さらに古い行があれば hasMore、読み足し中の行は busySeq', () => {
    expect(presentPeerToc(build({ turnCount: 2 }), 's1', ja, { clock })).toMatchObject({ rows: [], pending: true });
    const toc = presentPeerToc(build({ turnCount: 5, turnsLoaded: true, turnsMore: true, loadingTurns: true, turns: [turn('t4', 4), turn('t5', 5)], jumping: 't5' }), 's1', ja, { clock })!;
    expect(toc.hasMore).toBe(true);
    expect(toc.loading).toBe(true);
    expect(toc.busySeq).toBe(toc.rows[1]!.seq);
  });

  it('同じ時刻の行でも番号はぶつからない', () => {
    const toc = presentPeerToc(build({ turnCount: 2, turnsLoaded: true, turns: [turn('t1', 7), turn('t2', 7)] }), 's1', ja, { clock })!;
    expect(new Set(toc.rows.map((r) => r.seq)).size).toBe(2);
  });
});

describe('別の PC の会話の本文: 古い分', () => {
  it('読み足した古い分は本文の頭に並び、more と読み込み中と跳び先が画面へ渡る', () => {
    const st = build({ items: [item('c'), item('d')], older: [item('a'), item('b')], olderMore: true, loadingOlder: true, jump: { uuid: 'b', n: 2 } });
    const v = presentPeerChat(st, 's1', ja)!;
    expect(v.rows.map((r) => r.key)).toEqual(['a', 'b', 'c', 'd']);
    expect(v.hasOlder).toBe(true);
    expect(v.loadingOlder).toBe(true);
    expect(v.jump).toEqual({ uuid: 'b', n: 2 });
  });

  it('more が偽なら hasOlder は偽', () => {
    expect(presentPeerChat(build({ items: [item('c')], olderMore: false }), 's1', ja)!.hasOlder).toBe(false);
  });
});
