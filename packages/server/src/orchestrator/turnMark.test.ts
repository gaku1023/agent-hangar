import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../db/open.ts';
import { noteFedTurn, userTurnOf } from './turnMark.ts';

/**
 * 送り込みの印（docs/design.md「統括」の安全の境界の 3 と 4）。
 * 統括の今のターンが、利用者の入力で始まったか、hangar が送り込んだ [hangar] の文で始まったか。
 * 索引の session_stats（turns と last_prompt）を、索引が本文を読んだ結果として直に書いて確かめる。
 */

let db: Db;
const prompt = (turns: number, text: string | null) => {
  db.prepare('insert into session_stats (session_id, turns, last_prompt) values (?, ?, ?) on conflict(session_id) do update set turns = excluded.turns, last_prompt = excluded.last_prompt').run('orch', turns, text);
};

beforeEach(() => {
  db = openDb(':memory:');
  db.prepare("insert into sessions (id, provider, provider_session_id, cwd, home_device, updated_at, origin_device) values ('orch', 'claude-code', 'u-orch', '/w', 'd', 1, 'd')").run();
});

describe('userTurnOf', () => {
  it('利用者が打った最後の入力のターンでは真', () => {
    prompt(1, '読み取りは自分で許していいよ');
    expect(userTurnOf(db, 'orch')).toBe(true);
  });

  it('[hangar] の文で始まったターンでは偽', () => {
    prompt(2, '[hangar] 出来事 1 件\n- ask.permission s1 「ログイン修正」 Bash');
    expect(userTurnOf(db, 'orch')).toBe(false);
  });

  it('送り込んだ直後で、索引がまだ [hangar] の文を読んでいなくても偽（前の利用者の入力を今のターンと読まない）', () => {
    prompt(1, '許可します');
    noteFedTurn(db, 'orch');
    expect(userTurnOf(db, 'orch')).toBe(false);
    // 索引が [hangar] の文を読んだ。
    prompt(2, '[hangar] 出来事 1 件');
    expect(userTurnOf(db, 'orch')).toBe(false);
    // 利用者が続けて打った。
    prompt(3, '許可します');
    expect(userTurnOf(db, 'orch')).toBe(true);
  });

  it('入力がまだ無い会話と、要約で続けた頭は偽', () => {
    expect(userTurnOf(db, 'orch')).toBe(false);
    prompt(4, 'This session is being continued from a previous conversation that ran out of context.');
    expect(userTurnOf(db, 'orch')).toBe(false);
  });
});
