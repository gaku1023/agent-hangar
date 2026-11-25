import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CODEX_ONE_TURN, CODEX_SUBAGENT_A, CODEX_SUBAGENT_B, CODEX_SUBAGENT_PARENT, fixtureBytes, makeCodexHome, putRollout, rolloutName } from '../../../../test/codexFixtures.ts';
import { classifyCodexEntry, listRolloutFiles } from './discover.ts';
import { codexTranscriptSource } from './source.ts';

let home: string;
beforeEach(() => { home = makeCodexHome(); });
afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

const put = (f: { file: string; id: string }, when: string) => putRollout(home, rolloutName(f.id, when).rel, fixtureBytes(f.file));
const putAll = () => { put(CODEX_SUBAGENT_PARENT, '2026-11-25T20-14-16'); put(CODEX_SUBAGENT_A, '2026-11-25T20-14-35'); put(CODEX_SUBAGENT_B, '2026-11-25T20-14-36'); };

describe('子の rollout を親の会話のサブエージェントとして発見する', () => {
  it('session_meta の parent_thread_id がある rollout は、sessionId を親にし、agentId に自分の id を持つ。親は主線のまま', () => {
    putAll();
    const files = listRolloutFiles(home).files;
    const shape = files.map((f) => ({ s: f.sessionId, a: f.agentId })).sort((x, y) => `${x.s}${x.a ?? ''}`.localeCompare(`${y.s}${y.a ?? ''}`));
    expect(shape).toEqual([
      { s: CODEX_SUBAGENT_PARENT.id, a: null },
      { s: CODEX_SUBAGENT_PARENT.id, a: CODEX_SUBAGENT_A.id },
      { s: CODEX_SUBAGENT_PARENT.id, a: CODEX_SUBAGENT_B.id },
    ]);
  });

  it('圧縮された子（.jsonl.zst）も、先頭だけ展開して親を読む', () => {
    if (typeof zlib.zstdCompressSync !== 'function') return;
    put(CODEX_SUBAGENT_PARENT, '2026-11-25T20-14-16');
    const { rel } = rolloutName(CODEX_SUBAGENT_A.id, '2026-11-25T20-14-35');
    putRollout(home, rel + '.zst', zlib.zstdCompressSync(fixtureBytes(CODEX_SUBAGENT_A.file)));
    const child = listRolloutFiles(home).files.find((f) => f.agentId !== null);
    expect(child).toMatchObject({ sessionId: CODEX_SUBAGENT_PARENT.id, agentId: CODEX_SUBAGENT_A.id });
  });

  it('同じ親の子が複数あっても、会話の重複として捨てない（drop は空）', () => {
    putAll();
    expect(listRolloutFiles(home).drop).toEqual([]);
  });

  it('見張りの通知も、子の rollout を親の会話のサブエージェントに振り分ける。先頭がまだ書かれていない rollout は無視する', () => {
    putAll();
    const root = path.join(home, 'sessions');
    const childRel = path.relative(root, path.join(home, rolloutName(CODEX_SUBAGENT_A.id, '2026-11-25T20-14-35').rel));
    const w = classifyCodexEntry(root, childRel);
    expect(w).toMatchObject({ kind: 'file', file: { sessionId: CODEX_SUBAGENT_PARENT.id, agentId: CODEX_SUBAGENT_A.id } });
    const fresh = rolloutName('00000000-0000-7000-8000-0000000000ff', '2026-11-26T09-00-00');
    putRollout(home, fresh.rel, '');
    expect(classifyCodexEntry(root, path.relative(root, path.join(home, fresh.rel)))).toEqual({ kind: 'ignore' });
  });
});

describe('source の走査と実行中の本文', () => {
  const make = (limit?: number) => codexTranscriptSource({ codexHome: () => home, enabled: () => true, importLimit: limit });

  it('取り込みの上限は親の数で数え、子は親が入れば必ず入る', () => {
    put(CODEX_ONE_TURN, '2026-11-20T09-00-00');
    putAll();
    const r = make(1).scan({});
    expect(r.index.map((f) => `${f.sessionId}/${f.agentId}`).sort()).toEqual([
      `${CODEX_SUBAGENT_PARENT.id}/${CODEX_SUBAGENT_A.id}`, `${CODEX_SUBAGENT_PARENT.id}/${CODEX_SUBAGENT_B.id}`, `${CODEX_SUBAGENT_PARENT.id}/null`,
    ]);
  });

  it('liveFiles は親の主線と子の本文を返す', () => {
    putAll();
    const s = make();
    s.scan({});
    expect(s.liveFiles(CODEX_SUBAGENT_PARENT.id, '/work/sample').map((f) => f.agentId).sort()).toEqual([CODEX_SUBAGENT_A.id, CODEX_SUBAGENT_B.id, null].sort());
  });
});
