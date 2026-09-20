import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../db/open.ts';
import { SyncStateStore } from './state.ts';
import { TRANSCRIPTS_FROM, backfillTranscripts, markTranscriptsFrom, readTranscriptsFrom, stampTranscriptsFrom, transcriptsFrom } from './transcriptsFrom.ts';

const JOINED = 1_700_000_000_000;

let db: Db;
let state: SyncStateStore;

beforeEach(() => {
  db = openDb(':memory:');
  state = new SyncStateStore(db);
});

const homes: string[] = [];
afterEach(() => {
  while (homes.length) fs.rmSync(homes.pop()!, { recursive: true, force: true });
});

function tempHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-home-'));
  homes.push(home);
  return home;
}

/** home の索引から床を直に読む。入れ物が無ければ作らずに null を返す。 */
function floorInDb(home: string): string | null {
  const file = path.join(home, 'hangar.db');
  if (!fs.existsSync(file)) return null;
  const d = openDb(file);
  try { return new SyncStateStore(d).get(TRANSCRIPTS_FROM); } finally { d.close(); }
}

describe('本文を上げ始める時刻', () => {
  it('刻んでいなければ床なし（0）で、手元の本文を全部拾う形になる', () => {
    expect(state.get(TRANSCRIPTS_FROM)).toBeNull();
    expect(transcriptsFrom(state)).toBe(0);
  });

  it('渡された時刻を刻む', () => {
    markTranscriptsFrom(state, JOINED);
    expect(transcriptsFrom(state)).toBe(JOINED);
  });

  it('一度刻んだら上書きしない', () => {
    markTranscriptsFrom(state, JOINED);
    markTranscriptsFrom(state, JOINED + 86_400_000);
    expect(transcriptsFrom(state)).toBe(JOINED);
  });

  it('同期の進み具合が既にあっても床を消さない', () => {
    // 実物で起きた筋である。
    // 床を刻まない古いサーバが先に走って lastSeq と filesSeq を書いた後で、新しいサーバが起動した。
    // ここで「もう同期した端末だから床は要らない」と判断すると、上げないと決めた過去の本文が全部上がる。
    state.set('lastSeq', 42);
    state.set('filesSeq', 7);
    markTranscriptsFrom(state, JOINED);
    expect(transcriptsFrom(state)).toBe(JOINED);
  });

  it('時刻として読めない値を渡されたら床なしを刻む', () => {
    markTranscriptsFrom(state, 0);
    expect(state.get(TRANSCRIPTS_FROM)).toBe('0');
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

describe('stampTranscriptsFrom', () => {
  it('参加した時刻を home の索引に刻んで、その床を返す', () => {
    const home = tempHome();
    expect(stampTranscriptsFrom(home, JOINED)).toBe(JOINED);
    expect(floorInDb(home)).toBe(String(JOINED));
  });

  it('参加し直しても最初の床を動かさない', () => {
    const home = tempHome();
    stampTranscriptsFrom(home, JOINED);
    expect(stampTranscriptsFrom(home, JOINED + 86_400_000)).toBe(JOINED);
  });

  it('参加のときに刻んだ床は、古いサーバが先に走った後でも残る', () => {
    // 実物で起きた筋をそのまま辿る。
    const home = tempHome();
    stampTranscriptsFrom(home, JOINED);

    // 床を刻まない古いサーバが先に起動して、同期の進み具合だけを書く。
    const old = openDb(path.join(home, 'hangar.db'));
    try {
      const s = new SyncStateStore(old);
      s.set('lastSeq', 42);
      s.set('filesSeq', 7);
    } finally {
      old.close();
    }

    // そのあとで新しいサーバが起動して、保険の刻みを試みる。
    const now = openDb(path.join(home, 'hangar.db'));
    try {
      const s = new SyncStateStore(now);
      markTranscriptsFrom(s, Date.now());
      expect(transcriptsFrom(s)).toBe(JOINED);
    } finally {
      now.close();
    }
  });
});

describe('readTranscriptsFrom', () => {
  it('刻んだ床を読む', () => {
    const home = tempHome();
    stampTranscriptsFrom(home, JOINED);
    expect(readTranscriptsFrom(home)).toBe(JOINED);
  });

  it('索引がまだ無い home では 0 を返し、入れ物も作らない', () => {
    const home = tempHome();
    expect(readTranscriptsFrom(home)).toBe(0);
    expect(fs.existsSync(path.join(home, 'hangar.db'))).toBe(false);
  });
});

describe('backfillTranscripts', () => {
  it('床を 0 に落として、前の床を返す', () => {
    const home = tempHome();
    const first = openDb(path.join(home, 'hangar.db'));
    new SyncStateStore(first).set(TRANSCRIPTS_FROM, JOINED);
    first.close();

    expect(backfillTranscripts(home)).toEqual({ from: JOINED });
    expect(readTranscriptsFrom(home)).toBe(0);
  });
});
