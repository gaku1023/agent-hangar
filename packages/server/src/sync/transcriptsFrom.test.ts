import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../db/open.ts';
import { SyncStateStore } from './state.ts';
import { TRANSCRIPTS_FROM, backfillTranscripts, markTranscriptsFrom, transcriptsFrom } from './transcriptsFrom.ts';

const JOINED = 1_700_000_000_000;

let db: Db;
let state: SyncStateStore;

beforeEach(() => {
  db = openDb(':memory:');
  state = new SyncStateStore(db);
});

describe('本文を上げ始める時刻', () => {
  it('刻んでいなければ床なし（0）で、手元の本文を全部拾う形になる', () => {
    expect(state.get(TRANSCRIPTS_FROM)).toBeNull();
    expect(transcriptsFrom(state)).toBe(0);
  });

  it('クラウドを初めて見た時刻を刻む', () => {
    markTranscriptsFrom(state, JOINED);
    expect(transcriptsFrom(state)).toBe(JOINED);
  });

  it('一度刻んだら上書きしない', () => {
    markTranscriptsFrom(state, JOINED);
    markTranscriptsFrom(state, JOINED + 86_400_000);
    expect(transcriptsFrom(state)).toBe(JOINED);
  });

  it('既にクラウドと同期していた端末には床を置かない', () => {
    // この決まりが入る前から参加していた端末は、走査が全部を拾う約束で動いている。
    // 途中でその約束を変えると、上げ切る前の本文が黙って取り残される。
    state.set('lastSeq', 42);
    markTranscriptsFrom(state, JOINED);
    expect(transcriptsFrom(state)).toBe(0);
    // 刻んだことは残るので、次の起動で now が入ることもない。
    expect(state.get(TRANSCRIPTS_FROM)).toBe('0');
  });

  it('本文だけを降ろしていた端末にも床を置かない', () => {
    state.set('filesSeq', 7);
    markTranscriptsFrom(state, JOINED);
    expect(transcriptsFrom(state)).toBe(0);
  });

  it('手で書き換えられた値は床なしとして読む', () => {
    state.set(TRANSCRIPTS_FROM, 'あとで');
    expect(transcriptsFrom(state)).toBe(0);
    state.set(TRANSCRIPTS_FROM, -5);
    expect(transcriptsFrom(state)).toBe(0);
  });
});

describe('backfillTranscripts', () => {
  it('床を 0 に落として、前の床を返す', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-home-'));
    const first = openDb(path.join(home, 'hangar.db'));
    new SyncStateStore(first).set(TRANSCRIPTS_FROM, JOINED);
    first.close();

    expect(backfillTranscripts(home)).toEqual({ from: JOINED });

    const again = openDb(path.join(home, 'hangar.db'));
    try {
      expect(transcriptsFrom(new SyncStateStore(again))).toBe(0);
    } finally {
      again.close();
    }
    fs.rmSync(home, { recursive: true, force: true });
  });
});
