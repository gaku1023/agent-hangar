import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { creatorAccountIdOf } from './source.ts';

describe('creatorAccountIdOf', () => {
  it('先頭行の payload.creator_account_id を読む。無ければ null', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'creator-'));
    const a = path.join(dir, 'a.jsonl');
    const b = path.join(dir, 'b.jsonl');
    fs.writeFileSync(a, `${JSON.stringify({ type: 'session_meta', payload: { id: 'x', creator_account_id: 'cg-1' } })}\n{"type":"event_msg"}\n`);
    fs.writeFileSync(b, `${JSON.stringify({ type: 'session_meta', payload: { id: 'x' } })}\n`);
    expect(creatorAccountIdOf(a)).toBe('cg-1');
    expect(creatorAccountIdOf(b)).toBeNull();
    expect(creatorAccountIdOf(path.join(dir, 'none.jsonl'))).toBeNull();
    fs.rmSync(dir, { recursive: true });
  });
});
