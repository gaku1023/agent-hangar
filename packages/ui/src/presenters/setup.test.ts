import { describe, expect, it } from 'vitest';
import { translator } from '@agent-hangar/shared';
import { setupNotice } from './setup.ts';

const ja = translator('ja');
const en = translator('en');

describe('setupNotice', () => {
  it('書けたときと取り消したときは知らせない（承諾の窓が出している）', () => {
    expect(setupNotice(ja, { status: 'written', message: 'x', code: null })).toBeNull();
    expect(setupNotice(ja, { status: 'cancelled', message: 'x', code: null })).toBeNull();
  });
  it('済んでいたら info、書けなければ error で、理由の鍵から言語に合った文を引く', () => {
    expect(setupNotice(ja, { status: 'none', message: '登録済みです。', code: 'already' })).toEqual({ level: 'info', message: 'すでに設定されています。' });
    expect(setupNotice(en, { status: 'failed', message: '日本語の文', code: 'no-script' })!.message).toContain('/statusline');
    expect(setupNotice(en, { status: 'failed', message: '日本語の文', code: 'no-script' })!.level).toBe('error');
    // 知らない鍵は殻の文をそのまま出す。
    expect(setupNotice(ja, { status: 'failed', message: 'ロックを取れません', code: 'write-failed' })).toEqual({ level: 'error', message: 'ロックを取れません' });
    expect(setupNotice(en, { status: 'busy', message: null, code: null })!.message).toContain('already open');
  });
});
