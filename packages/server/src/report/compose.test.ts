import { describe, expect, it } from 'vitest';
import { MessageError } from '../i18n/message.ts';
import { composeReport, parseReportInput, REPORT_MARKER } from './compose.ts';

const env = { hangarVersion: '0.6.1', claudeVersion: '2.1.300', os: 'darwin 27.0.0', arch: 'arm64' };

describe('parseReportInput', () => {
  it('不具合は症状と再現の手順が要る', () => {
    expect(() => parseReportInput({ kind: 'bug', title: 't', symptom: 's' })).toThrow(MessageError);
    expect(parseReportInput({ kind: 'bug', title: ' t ', symptom: 's', steps: '1. a', notes: '  ' }))
      .toEqual({ kind: 'bug', title: 't', sections: [['symptom', 's'], ['steps', '1. a']] });
  });

  it('要望は困っていることと欲しいものが要る', () => {
    expect(() => parseReportInput({ kind: 'request', title: 't', problem: 'p' })).toThrow(MessageError);
    expect(parseReportInput({ kind: 'request', title: 't', problem: 'p', proposal: 'q', alternatives: 'a' }))
      .toEqual({ kind: 'request', title: 't', sections: [['problem', 'p'], ['proposal', 'q'], ['alternatives', 'a']] });
  });

  it('種類と題名が無ければ断る', () => {
    expect(() => parseReportInput({ kind: 'other', title: 't' })).toThrow(MessageError);
    expect(() => parseReportInput({ kind: 'bug', title: ' ', symptom: 's', steps: 'x' })).toThrow(MessageError);
  });

  it('文字列でない節は断る', () => {
    expect(() => parseReportInput({ kind: 'bug', title: 't', symptom: 's', steps: 'x', cause: 3 })).toThrow(MessageError);
  });
});

describe('composeReport', () => {
  it('題名の頭に種類を付け、節と環境と印を並べる', () => {
    const input = parseReportInput({ kind: 'bug', title: '一覧が出ない', symptom: '空になる', steps: '1. 開く', fix: '直す' });
    const r = composeReport(input, env, 'ja');
    expect(r.title).toBe('[bug] 一覧が出ない');
    expect(r.body).toBe([
      '## 症状', '', '空になる', '',
      '## 再現手順', '', '1. 開く', '',
      '## 修正案', '', '直す', '',
      '## 環境', '',
      '- hangar: 0.6.1',
      '- Claude Code: 2.1.300',
      '- OS: darwin 27.0.0',
      '- arch: arm64',
      '',
      REPORT_MARKER,
      '',
    ].join('\n'));
  });

  it('頭がすでに付いていれば重ねない。Claude Code の版が無ければ不明と書く', () => {
    const input = parseReportInput({ kind: 'request', title: '[request] 色を選びたい', problem: 'p', proposal: 'q' });
    const r = composeReport(input, { ...env, claudeVersion: null }, 'en');
    expect(r.title).toBe('[request] 色を選びたい');
    expect(r.body).toContain('## Problem');
    expect(r.body).toContain('- Claude Code: unknown');
  });
});
