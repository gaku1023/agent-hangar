import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { firstPromptUses } from './history.ts';

let file: string;
const line = (sessionId: string, display: string) => JSON.stringify({ display, sessionId, timestamp: 1, project: '/p' });
beforeEach(() => { file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-hist-')), 'history.jsonl'); });

describe('firstPromptUses', () => {
  it('セッションごとの最初の一言だけを数える', () => {
    fs.writeFileSync(file, [line('a', '/goal 速くする'), line('a', '/review'), line('b', 'こんにちは'), line('c', '/goal'), line('d', '  /superpowers:brainstorming x')].join('\n') + '\n');
    expect([...firstPromptUses(file)]).toEqual([['goal', 2], ['superpowers:brainstorming', 1]]);
  });
  it('壊れた行と sessionId の無い行は飛ばす', () => {
    fs.writeFileSync(file, ['{こわれた', JSON.stringify({ display: '/goal' }), line('a', '/toggle on')].join('\n'));
    expect([...firstPromptUses(file)]).toEqual([['toggle', 1]]);
  });
  it('ファイルが無ければ空を返す', () => {
    expect(firstPromptUses(path.join(os.tmpdir(), 'hangar-no-such-history.jsonl')).size).toBe(0);
  });
  it('ファイルが変わったら数え直す', () => {
    fs.writeFileSync(file, line('a', '/goal') + '\n');
    expect(firstPromptUses(file).get('goal')).toBe(1);
    fs.writeFileSync(file, line('a', '/goal') + '\n' + line('b', '/goal') + '\n');
    expect(firstPromptUses(file).get('goal')).toBe(2);
  });
});
