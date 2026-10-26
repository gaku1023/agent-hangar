import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TranscriptFile, TranscriptSink } from '../../../agent/types.ts';
import { CODEX_ONE_TURN, fixtureBytes, makeCodexHome, putRollout, rolloutName } from '../../../../test/codexFixtures.ts';
import { classifyCodexEntry, parseRolloutName } from './discover.ts';
import { codexTranscriptSource, type WatchFn } from './source.ts';

let home: string;
beforeEach(() => { home = makeCodexHome(); });
afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

const uuid = (n: number) => `00000000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const put = (n: number, when: string, ext = '') => { const { rel } = rolloutName(uuid(n), when); return putRollout(home, rel + ext, fixtureBytes(ext ? `${CODEX_ONE_TURN.file}.zst` : CODEX_ONE_TURN.file)); };
const make = (on: { enabled?: boolean; limit?: number; isLive?: (id: string) => boolean; watch?: WatchFn } = {}) =>
  codexTranscriptSource({ codexHome: () => home, enabled: () => on.enabled ?? true, importLimit: on.limit, isLive: on.isLive, watch: on.watch });
const names = (files: TranscriptFile[]) => files.map((f) => path.basename(f.path));

describe('rollout の名前', () => {
  it('.jsonl と .jsonl.zst の名前から、会話の ID と論理パスの名前を取る。ほかの名前は null', () => {
    const id = uuid(7);
    expect(parseRolloutName(`rollout-2026-10-26T14-00-00-${id}.jsonl`)).toMatchObject({ sessionId: id, compressed: false, logicalName: `rollout-2026-10-26T14-00-00-${id}.jsonl` });
    expect(parseRolloutName(`rollout-2026-10-26T14-00-00-${id}.jsonl.zst`)).toMatchObject({ sessionId: id, compressed: true, logicalName: `rollout-2026-10-26T14-00-00-${id}.jsonl` });
    for (const n of ['auth.json', 'config.toml', 'state_5.sqlite', 'logs_2.sqlite-wal', `rollout-2026-10-26T14-00-00-${id}.jsonl.tmp`, 'history.jsonl']) expect(parseRolloutName(n)).toBeNull();
  });
});

describe('scan（発見）', () => {
  it('3 日ぶんを日付の降順で列挙する。.zst は論理パス（.jsonl）で、stat は実体のもの', () => {
    put(1, '2026-10-24T09-00-00'); put(2, '2026-10-25T09-00-00'); put(3, '2026-10-26T09-00-00', '.zst');
    const r = make().scan({});
    expect(names(r.index)).toEqual([3, 2, 1].map((n) => `rollout-2026-10-${23 + n}T09-00-00-${uuid(n)}.jsonl`));
    const z = r.index[0]!;
    expect(z.path.endsWith('.jsonl')).toBe(true);
    expect(r.stats.get(z.path)?.size).toBe(fixtureBytes(`${CODEX_ONE_TURN.file}.zst`).length);
    expect(r.seen).toEqual(new Set(r.index.map((f) => f.path)));
  });

  it('切のときは空と seen: null を返し、見張りも付けない', () => {
    put(1, '2026-10-24T09-00-00');
    const watched: string[] = [];
    const watch: WatchFn = (dir) => { watched.push(dir); return { close() {}, on: () => undefined }; };
    const s = make({ enabled: false, watch });
    s.start({} as TranscriptSink);
    expect(s.scan({})).toMatchObject({ index: [], drop: [], seen: null });
    expect(s.pick({ path: 'x', sessionId: 'y', agentId: null, deviceId: null }, { size: 1, mtimeMs: 1 }, {})).toMatchObject({ index: [], lost: false });
    expect(watched).toEqual([]);
    expect(s.healthy()).toBe(true);
  });

  it('取り込みの上限：索引に無いものは新しい 2 件だけ。索引済みと実行中は上限に数えず、残る', () => {
    for (let n = 1; n <= 6; n++) put(n, `2026-10-2${n}T09-00-00`);
    const indexed = new Set([put(1, '2026-10-21T09-00-00')]);
    const s = make({ limit: 2, isLive: (id) => id === uuid(2) });
    const r = s.scan({ isIndexed: (p) => indexed.has(p) });
    // 新しい方の 6 と 5、索引済みの 1、実行中の 2。
    expect(new Set(r.index.map((f) => f.sessionId))).toEqual(new Set([uuid(6), uuid(5), uuid(1), uuid(2)]));
    // 3 と 4 は seen に入っているので、あとで索引に入れば消されない。
    expect(r.seen!.size).toBe(6);
  });

  it('sessions が無いとき seen は null（索引を消さない）。archived は拾い、同じ会話が両方にあれば sessions を正にして残りを drop に入れる', () => {
    const id = uuid(9);
    putRollout(home, `archived_sessions/rollout-2026-10-20T09-00-00-${id}.jsonl`, fixtureBytes(CODEX_ONE_TURN.file));
    const noSessions = make().scan({});
    expect(noSessions.seen).toBeNull();
    expect(noSessions.index).toHaveLength(1);
    put(9, '2026-10-20T09-00-00');
    const both = make().scan({});
    expect(both.index).toHaveLength(1);
    expect(both.index[0]!.path).toContain(`${path.sep}sessions${path.sep}`);
    expect(both.drop.map((f) => f.path)).toEqual([path.join(home, 'archived_sessions', `rollout-2026-10-20T09-00-00-${id}.jsonl`)]);
  });

  it('auth.json、config.toml、sqlite など rollout でないファイルは数えない', () => {
    put(1, '2026-10-24T09-00-00');
    for (const n of ['auth.json', 'config.toml', 'state_5.sqlite']) putRollout(home, n, 'secret');
    putRollout(home, 'sessions/2026/10/24/notes.txt', 'x');
    expect(make().scan({}).index).toHaveLength(1);
  });

  it('liveFiles は、ID から本文の論理パスを引く（置き場を歩いて見つける）', () => {
    const p = put(4, '2026-10-26T09-00-00', '.zst');
    expect(make().liveFiles(uuid(4), '/work/sample').map((f) => f.path)).toEqual([p.replace(/\.zst$/, '')]);
    expect(make().liveFiles(uuid(5), '/work/sample')).toEqual([]);
    expect(make({ enabled: false }).liveFiles(uuid(4), '/x')).toEqual([]);
  });
});

describe('classifyCodexEntry', () => {
  const root = '/h/sessions';
  it('rollout の作成は named、.jsonl.zst の名前は論理パスで named、ほかは無視、名前の無い通知は rescan', () => {
    const id = uuid(3);
    const n = `rollout-2026-10-26T09-00-00-${id}.jsonl`;
    expect(classifyCodexEntry(root, `2026/10/26/${n}`)).toEqual({ kind: 'file', file: { path: path.join(root, '2026/10/26', n), sessionId: id, agentId: null, deviceId: null } });
    expect(classifyCodexEntry(root, `2026/10/26/${n}.zst`)).toMatchObject({ kind: 'file', file: { path: path.join(root, '2026/10/26', n) } });
    for (const x of ['2026/10/26', 'state_5.sqlite', 'auth.json', 'config.toml', '2026/10/26/x.log']) expect(classifyCodexEntry(root, x)).toEqual({ kind: 'ignore' });
    expect(classifyCodexEntry(root, null)).toEqual({ kind: 'rescan' });
    expect(classifyCodexEntry(root, '../escape')).toEqual({ kind: 'rescan' });
  });
});

describe('見張り', () => {
  type Handle = { dir: string; fire(name: string | null): void; closed: boolean };
  const fakeWatch = () => {
    const handles: Handle[] = [];
    const watch: WatchFn = (dir, _o, listener) => {
      const h: Handle = { dir, fire: (name) => listener('rename', name), closed: false };
      handles.push(h);
      return { close() { h.closed = true; }, on: () => undefined };
    };
    return { handles, watch };
  };
  const sinkOf = () => {
    const calls = { named: [] as TranscriptFile[], rescan: 0, error: [] as string[] };
    const sink: TranscriptSink = { batch() {}, named: (f) => calls.named.push(f), rescan: () => { calls.rescan++; }, historyChanged() {}, error: (p, m) => calls.error.push(`${p}:${m}`) };
    return { calls, sink };
  };

  it('sessions に再帰の見張りを付け、新しい rollout の通知を named で渡す。sqlite、auth.json の通知は読み出しに来ない', () => {
    put(1, '2026-10-24T09-00-00');
    const { handles, watch } = fakeWatch();
    const { calls, sink } = sinkOf();
    const s = make({ watch });
    s.start(sink);
    expect(handles.map((h) => h.dir)).toEqual([path.join(home, 'sessions')]);
    const id = uuid(8);
    handles[0]!.fire(`2026/10/26/rollout-2026-10-26T09-00-00-${id}.jsonl`);
    handles[0]!.fire(`2026/10/26/rollout-2026-10-26T09-00-00-${id}.jsonl.zst`);
    handles[0]!.fire('state_5.sqlite');
    handles[0]!.fire('auth.json');
    handles[0]!.fire(null);
    expect(calls.named.map((f) => f.sessionId)).toEqual([id, id]);
    expect(calls.rescan).toBe(1);
    expect(s.healthy()).toBe(true);
    s.stop();
    expect(handles[0]!.closed).toBe(true);
  });

  it('sessions が後から現れても付く（ホームを見て、現れたら付け、全件の見比べを頼む）', () => {
    const { handles, watch } = fakeWatch();
    const { calls, sink } = sinkOf();
    const s = make({ watch });
    s.start(sink);
    expect(handles.map((h) => h.dir)).toEqual([home]);
    expect(s.healthy()).toBe(true);
    handles[0]!.fire('config.toml');
    expect(handles).toHaveLength(1);
    fs.mkdirSync(path.join(home, 'sessions'));
    handles[0]!.fire('sessions');
    expect(handles.map((h) => h.dir)).toEqual([home, path.join(home, 'sessions')]);
    expect(handles[0]!.closed).toBe(true);
    expect(calls.rescan).toBe(1);
  });

  it('設定の切り替え：入に変えると見張りを付けて rescan を 1 回送り、切に変えると見張りを外す（索引は消さない）', () => {
    put(1, '2026-10-24T09-00-00');
    const { handles, watch } = fakeWatch();
    const { calls, sink } = sinkOf();
    let on = false;
    const s = codexTranscriptSource({ codexHome: () => home, enabled: () => on, watch });
    s.start(sink);
    expect(handles).toHaveLength(0);
    on = true;
    s.setEnabled!(true);
    expect(handles.map((h) => h.dir)).toEqual([path.join(home, 'sessions')]);
    expect(calls.rescan).toBe(1);
    on = false;
    s.setEnabled!(false);
    expect(handles[0]!.closed).toBe(true);
    // 切の間の通知は読みに来ない。
    handles[0]!.fire(`2026/10/26/rollout-2026-10-26T09-00-00-${uuid(2)}.jsonl`);
    expect(calls.named).toEqual([]);
    expect(s.scan({}).seen).toBeNull();
  });
});

describe('read（枠の知らせ）', () => {
  it('束の中の最後の meta rate_limits を onRateLimits へ渡す（枠の行が無ければ呼ばない）', () => {
    put(1, '2026-10-26T09-00-00');
    const seen: { value: unknown; ts: unknown }[] = [];
    const s = codexTranscriptSource({ codexHome: () => home, enabled: () => true, onRateLimits: (value, ts) => { seen.push({ value, ts }); } });
    const file = s.scan({}).index[0]!;
    s.read(file, 0);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.value).toMatchObject({ rate_limits: { limit_id: 'codex', primary: { used_percent: 3 } } });
    expect(typeof seen[0]!.ts === 'string' || typeof seen[0]!.ts === 'number').toBe(true);
  });
  it('切のときは呼ばない', () => {
    put(1, '2026-10-26T09-00-00');
    const seen: unknown[] = [];
    let on = true;
    const s = codexTranscriptSource({ codexHome: () => home, enabled: () => on, onRateLimits: (v) => { seen.push(v); } });
    const file = s.scan({}).index[0]!;
    on = false;
    s.read(file, 0);
    expect(seen).toEqual([]);
  });
});
