import { describe, expect, it } from 'vitest';
import { failureSummary, hasBashSleep } from './transcript.ts';

const line = (rec: unknown): string => JSON.stringify(rec);
const asst = (...blocks: unknown[]): string => line({ type: 'assistant', message: { role: 'assistant', content: blocks } });

describe('hasBashSleep', () => {
  it('利用者の指示の文に sleep 20 があるだけでは満たさない', () => {
    const user = line({ type: 'user', message: { role: 'user', content: 'Use the Bash tool to run exactly: sleep 20 && ls' } });
    expect(hasBashSleep(user + '\n')).toBe(false);
  });
  it('assistant の Bash の tool_use で、command に sleep 20 があるときだけ満たす', () => {
    const ok = asst({ type: 'text', text: 'ok' }, { type: 'tool_use', id: 't', name: 'Bash', input: { command: 'sleep 20 && ls' } });
    expect(hasBashSleep(ok + '\n')).toBe(true);
    expect(hasBashSleep(asst({ type: 'tool_use', id: 't', name: 'Write', input: { command: 'sleep 20' } }) + '\n')).toBe(false);
    expect(hasBashSleep(asst({ type: 'tool_use', id: 't', name: 'Bash', input: { command: 'ls' } }) + '\n')).toBe(false);
    expect(hasBashSleep(asst({ type: 'text', text: 'I will run sleep 20' }) + '\n')).toBe(false);
  });
  it('書きかけの行と壊れた行は飛ばす', () => {
    const ok = asst({ type: 'tool_use', id: 't', name: 'Bash', input: { command: 'sleep 20 && ls' } });
    expect(hasBashSleep('{"type":"assistant","message":{"con\n' + ok + '\n{"type":')).toBe(true);
    expect(hasBashSleep('{"type":"assistant","mess')).toBe(false);
    expect(hasBashSleep('')).toBe(false);
  });
});

describe('failureSummary', () => {
  it('ファイルごとの行数、行の type ごとの数、tool_use の名前を返す。パスや本文は出さない', () => {
    const transcript = [
      line({ type: 'user', message: { role: 'user', content: 'secret text in /Users/someone/x' } }),
      asst({ type: 'text', text: 'secret text' }, { type: 'tool_use', id: 't', name: 'Bash', input: { command: 'echo secret' } }),
      asst({ type: 'tool_use', id: 'u', name: 'Write', input: { file_path: '/Users/someone/notes.txt' } }),
      '{"type":"assis',
    ].join('\n');
    const s = failureSummary([['transcript.jsonl', 4], ['registry.jsonl', 1]], transcript);
    expect(s).toContain('transcript.jsonl: 4 行');
    expect(s).toContain('registry.jsonl: 1 行');
    expect(s).toContain('assistant: 2');
    expect(s).toContain('user: 1');
    expect(s).toContain('Bash');
    expect(s).toContain('Write');
    expect(s).not.toContain('secret');
    expect(s).not.toContain('someone');
  });
  it('名前の形でない type と道具の名前は (other) にまとめる', () => {
    const s = failureSummary([], line({ type: '/Users/someone/x' }) + '\n' + asst({ type: 'tool_use', name: 'a b/c' }));
    expect(s).not.toContain('someone');
    expect(s).toContain('(other)');
  });
});
