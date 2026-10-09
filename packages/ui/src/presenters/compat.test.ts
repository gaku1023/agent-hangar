import { describe, expect, it } from 'vitest';
import type { CompatDriftDto, CompatDto, CompatSummaryDto } from '@agent-hangar/shared';
import { compatReport, CONTRACT_LABEL, presentCompat, seenLabel, stopOf } from './compat.ts';

// 時刻は端末の時刻帯で組む。表は端末の時刻で書くので、どの時刻帯でも同じ文字になる。
const at = (d: number, h: number, m: number) => new Date(2026, 9, d, h, m).getTime();
const drift = (contract: CompatDriftDto['contract'], value: string, over: Partial<CompatDriftDto> = {}): CompatDriftDto => ({ contract, value, version: '2.1.300', count: 1, firstSeenAt: at(7, 14, 2), lastSeenAt: at(7, 14, 9), ...over });
const SUM: CompatSummaryDto = { verifiedVersion: '2.1.292', localVersion: '2.1.300', driftCount: 3 };
// 試作の 3 件。2 件が機能を止め、1 件は記録だけである。
const DETAIL: CompatDto = {
  verifiedVersion: '2.1.292', localVersion: '2.1.300', drifts: [
    drift('screen', 'prompt-marker=(missing)', { count: 2 }),
    drift('registry', 'status=compacting', { count: 5, firstSeenAt: at(7, 13, 40), lastSeenAt: at(7, 14, 5) }),
    drift('transcript', 'system.subtype=turn_summary', { version: '2.1.298', count: 9, firstSeenAt: at(6, 22, 15), lastSeenAt: at(7, 14, 1) }),
  ],
};

describe('止めた機能の表（stopOf）', () => {
  it('試作の 3 行：画面の文字は目次から跳ぶ、レジストリの状態は休みで止める、トランスクリプトは記録だけ', () => {
    expect(stopOf(drift('screen', 'prompt-marker=(missing)'))).toEqual({ short: '目次から跳ぶ', line: 'ターンの目次から端末の指示へ跳ぶのを止めています' });
    expect(stopOf(drift('screen', 'transcript-footer=(missing)'))?.short).toBe('目次から跳ぶ');
    expect(stopOf(drift('registry', 'status=compacting'))).toEqual({ short: '休みで止める', line: '休んでいるセッションを自動で止めるのを控えています' });
    expect(stopOf(drift('transcript', 'system.subtype=turn_summary'))).toBeNull();
    expect(stopOf(drift('transcript', 'attachment.type=queued_prompt'))).toBeNull();
  });
  it('レジストリは、pid が無ければ引き取りを、読めない登録は実行中の印を止める', () => {
    expect(stopOf(drift('registry', 'pid=(missing)'))).toEqual({ short: '引き取り', line: '外のターミナルで動いている会話を引き取るのを止めています' });
    expect(stopOf(drift('registry', 'sessionId=(missing)'))).toEqual({ short: '実行中の印', line: '状態のファイルが読めない会話を、実行中として出すのを控えています' });
    expect(stopOf(drift('registry', 'entry=(not-object)'))?.short).toBe('実行中の印');
  });
  it('statusline は、ミリ秒の resets_at は記録だけで、欠けた項目は使用率の一部を止める', () => {
    expect(stopOf(drift('statusline', 'rate_limits.seven_day.resets_at=ms'))).toBeNull();
    expect(stopOf(drift('statusline', 'rate_limits.five_hour.resets_at=(missing)'))).toEqual({ short: '使用率の一部', line: '使用率のゲージの欠けた項目の更新を止めています' });
    expect(stopOf(drift('statusline', 'session_id=(missing)'))?.short).toBe('使用率の一部');
  });
  it('~/.claude の項目は、アカウントの間で共有するのを控える', () => {
    expect(stopOf(drift('claude-dir', 'entry=brand-new'))).toEqual({ short: 'アカウントの共有', line: '新しい ~/.claude の項目をアカウントの間で共有するのを控えています' });
  });
  it('CLI は出力の種類ごとに止めるものが違い、サブコマンドの増減は記録だけ', () => {
    expect(stopOf(drift('cli', 'help.commands=(missing)'))).toEqual({ short: '外のターミナル', line: '外のターミナルの包み方で、サブコマンドの一覧を claude --help から作るのを止めています' });
    expect(stopOf(drift('cli', 'auth-status=(not-json)'))).toEqual({ short: 'ログインの状態', line: 'アカウントのログインの状態を読むのを止めています' });
    expect(stopOf(drift('cli', 'auth-status.loggedIn=(missing)'))?.short).toBe('ログインの状態');
    expect(stopOf(drift('cli', 'agents-json.kind=remote'))).toEqual({ short: 'attach で再開', line: 'バックグラウンドのセッションを attach で再開するのを止めています' });
    expect(stopOf(drift('cli', 'print-json.structured_output=(missing)'))).toEqual({ short: 'Claude で要約', line: 'Claude で要約するのを止めています' });
    expect(stopOf(drift('cli', 'subcommand.added=newcmd'))).toBeNull();
    expect(stopOf(drift('cli', 'subcommand.removed=purge'))).toBeNull();
  });
  it('止めた機能の 1 行は、どれも「〜を止めています」か「〜を控えています」で結ぶ（B1）', () => {
    const cases: [CompatDriftDto['contract'], string][] = [
      ['screen', 'prompt-marker=(missing)'], ['registry', 'status=x'], ['registry', 'pid=(missing)'], ['registry', 'entry=(not-object)'],
      ['statusline', 'model=(missing)'], ['claude-dir', 'entry=x'], ['cli', 'help.commands=(missing)'], ['cli', 'auth-status=(not-json)'],
      ['cli', 'agents-json=(not-json)'], ['cli', 'print-json=(not-json)'],
    ];
    for (const [c, v] of cases) expect(stopOf(drift(c, v))!.line, `${c} ${v}`).toMatch(/(止めています|控えています)$/);
  });
  it('契約の呼び名は spec の 6 つ', () => {
    expect(CONTRACT_LABEL).toEqual({ transcript: 'トランスクリプト', registry: 'レジストリ', statusline: 'statusline', 'claude-dir': '~/.claude の項目', cli: 'CLI', screen: '画面の文字' });
  });
});

describe('seenLabel', () => {
  it('表の時刻は、月と日と時刻だけにする', () => {
    expect(seenLabel(at(7, 9, 5))).toBe('10/07 09:05');
  });
});

describe('presentCompat', () => {
  it('問題なしは、確かめた版だけを添えて、見張っていると言う', () => {
    expect(presentCompat({ verifiedVersion: '2.1.292', localVersion: '2.1.292', driftCount: 0 }, null, '0.3.0')).toEqual({
      state: 'ok', note: 'ずれなし（2.1.292 で確かめた版）', lead: 'hangar が読む Claude Code の形を見張っています', badge: '問題なし',
      localVersion: '2.1.292', verifiedVersion: '2.1.292', count: 0, stops: null, rows: null, report: null,
    });
  });
  it('未確認の版は、手元の版と確かめた版を出し、止めていないと言う', () => {
    expect(presentCompat({ verifiedVersion: '2.1.292', localVersion: '2.1.300', driftCount: 0 }, null, '')).toEqual({
      state: 'unverified', note: '2.1.300（確かめた版は 2.1.292）', lead: 'まだ確かめていない版です。動きは止めていません', badge: '未確認の版',
      localVersion: '2.1.300', verifiedVersion: '2.1.292', count: 0, stops: null, rows: null, report: null,
    });
  });
  it('ずれの中身が届く前は、件数だけを出して読み込み中と言う', () => {
    expect(presentCompat(SUM, null, '')).toEqual({
      state: 'drift', note: 'ずれ 3 件（2.1.300）', lead: 'ずれの中身を読み込んでいます', badge: 'ずれ 3 件',
      localVersion: '2.1.300', verifiedVersion: '2.1.292', count: 3, stops: null, rows: null, report: null,
    });
  });
  it('止めた機能は機能ごとに 1 行にまとめて常に出し、表は 1 件ずつ届いた順に並べる', () => {
    const more: CompatDto = { ...DETAIL, drifts: [...DETAIL.drifts, drift('registry', 'status=thinking'), drift('screen', 'transcript-footer=(missing)')] };
    const p = presentCompat({ ...SUM, driftCount: 5 }, more, '0.3.0');
    expect(p.stops).toEqual(['ターンの目次から端末の指示へ跳ぶのを止めています', '休んでいるセッションを自動で止めるのを控えています']);
    expect(p.lead).toBe('知らない形に頼る機能だけを止め、ほかは動かしています');
    expect(p.rows).toHaveLength(5);
    expect(p.rows!.slice(0, 3)).toEqual([
      { key: 'screen:prompt-marker=(missing)', contract: '画面の文字', value: 'prompt-marker=(missing)', version: '2.1.300', firstSeen: '10/07 14:02', stop: '目次から跳ぶ' },
      { key: 'registry:status=compacting', contract: 'レジストリ', value: 'status=compacting', version: '2.1.300', firstSeen: '10/07 13:40', stop: '休みで止める' },
      { key: 'transcript:system.subtype=turn_summary', contract: 'トランスクリプト', value: 'system.subtype=turn_summary', version: '2.1.298', firstSeen: '10/06 22:15', stop: null },
    ]);
  });
  it('中身が届いていれば、件数は中身の数にそろえる', () => {
    expect(presentCompat({ ...SUM, driftCount: 1 }, DETAIL, '')).toMatchObject({ count: 3, note: 'ずれ 3 件（2.1.300）', badge: 'ずれ 3 件' });
  });
  it('ずれはあっても止めた機能が無ければ、一覧を空にして、記録だけだと言う', () => {
    const only: CompatDto = { ...DETAIL, drifts: [drift('cli', 'subcommand.added=newcmd', { version: null }), drift('statusline', 'rate_limits.five_hour.resets_at=ms')] };
    const p = presentCompat({ ...SUM, driftCount: 2 }, only, '');
    expect(p).toMatchObject({ state: 'drift', badge: 'ずれ 2 件', stops: [], lead: '知らない形を記録しましたが、止めた機能はありません' });
    expect(p.rows!.map((r) => [r.version, r.stop])).toEqual([['不明', null], ['2.1.300', null]]);
  });
  it('手元の版が分からなければ「不明」と書き、6 行目の件数には版を添えない', () => {
    expect(presentCompat({ ...SUM, localVersion: null }, DETAIL, '')).toMatchObject({ state: 'drift', note: 'ずれ 3 件', localVersion: '不明' });
    expect(presentCompat({ verifiedVersion: '2.1.292', localVersion: null, driftCount: 0 }, null, '')).toMatchObject({ state: 'ok', localVersion: '不明' });
  });
});

describe('compatReport', () => {
  it('ずれの一覧を、回数と最後に見た時刻も持つ Markdown の表にする', () => {
    expect(compatReport(SUM, DETAIL.drifts, '0.3.0')).toBe([
      'Claude Code との互換のずれ（hangar 0.3.0）',
      '手元の版 2.1.300、確かめた版 2.1.292',
      '',
      '| 契約 | 値 | 版 | 回数 | 最初に見た | 最後に見た | 止めた機能 |',
      '| --- | --- | --- | --- | --- | --- | --- |',
      '| 画面の文字 | `prompt-marker=(missing)` | 2.1.300 | 2 | 2026-10-07 14:02 | 2026-10-07 14:09 | 目次から跳ぶ |',
      '| レジストリ | `status=compacting` | 2.1.300 | 5 | 2026-10-07 13:40 | 2026-10-07 14:05 | 休みで止める |',
      '| トランスクリプト | `system.subtype=turn_summary` | 2.1.298 | 9 | 2026-10-06 22:15 | 2026-10-07 14:01 | なし |',
    ].join('\n'));
    expect(presentCompat(SUM, DETAIL, '0.3.0').report).toBe(compatReport(SUM, DETAIL.drifts, '0.3.0'));
  });
  it('値の縦棒と改行で表が崩れず、バッククォートのある値は 2 つで囲む。hangar の版が無ければ頭に書かない', () => {
    const text = compatReport({ ...SUM, localVersion: null }, [drift('transcript', 'type=a|b\nc'), drift('cli', 'subcommand.added=x`y', { version: null })], '');
    const lines = text.split('\n');
    expect(lines.slice(0, 2)).toEqual(['Claude Code との互換のずれ', '手元の版 不明、確かめた版 2.1.292']);
    expect(lines[5]).toBe('| トランスクリプト | `type=a\\|b c` | 2.1.300 | 1 | 2026-10-07 14:02 | 2026-10-07 14:09 | なし |');
    expect(lines[6]).toBe('| CLI | `` subcommand.added=x`y `` | 不明 | 1 | 2026-10-07 14:02 | 2026-10-07 14:09 | なし |');
  });
});
