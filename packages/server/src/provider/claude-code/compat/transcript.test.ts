import { describe, expect, it } from 'vitest';
import { transcriptDrifts, transcriptWatcher } from './transcript.ts';
import type { Drift } from './types.ts';

const t = (value: string): Drift => ({ contract: 'transcript', value, version: null });

describe('transcriptDrifts', () => {
  it('知っている行はずれを出さない', () => {
    for (const r of [
      { type: 'user', message: { role: 'user', content: 'こんにちは' } },
      { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'x' }, { type: 'image' }, { type: 'document' }, { type: 'tool_result', tool_use_id: 't', content: 'ok' }] } },
      { type: 'assistant', message: { content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: '' }, { type: 'tool_use', id: 't', name: 'Bash', input: {} }] } },
      { type: 'system', subtype: 'turn_duration' },
      { type: 'attachment', attachment: { type: 'queued_command', prompt: 'x', commandMode: 'prompt' } },
      { type: 'ai-title', aiTitle: 'x' },
      { type: 'summary', summary: 'x' },
    ]) expect(transcriptDrifts(r), JSON.stringify(r)).toEqual([]);
    expect(transcriptDrifts('x')).toEqual([]);
    expect(transcriptDrifts(null)).toEqual([]);
  });
  it('isolation-latch（2.1.295 で現れた、side と sessionId だけの行）は meta として知っている', () => {
    expect(transcriptDrifts({ type: 'isolation-latch', side: 'connectors', sessionId: 's' })).toEqual([]);
  });
  it('知らない行の種類と system の種類を返す。添付は、知らない種類が文字の prompt を持つときだけ返す。無いものは (missing) と書く', () => {
    expect(transcriptDrifts({ type: 'brand-new' })).toEqual([t('type=brand-new')]);
    expect(transcriptDrifts({ sessionId: 'x' })).toEqual([t('type=(missing)')]);
    expect(transcriptDrifts({ type: 'system', subtype: 'turn_end' })).toEqual([t('system.subtype=turn_end')]);
    expect(transcriptDrifts({ type: 'system' })).toEqual([t('system.subtype=(missing)')]);
    expect(transcriptDrifts({ type: 'attachment', attachment: { type: 'brand_new' } })).toEqual([]);
    expect(transcriptDrifts({ type: 'attachment', attachment: { type: 'queued_prompt', prompt: 'x' } })).toEqual([t('attachment.type=queued_prompt')]);
    expect(transcriptDrifts({ type: 'attachment' })).toEqual([t('attachment.type=(missing)')]);
  });
  it('知らない本文の塊は、種類ごとに 1 つだけ返す', () => {
    expect(transcriptDrifts({ type: 'assistant', message: { content: [{ type: 'server_tool_use' }, { type: 'server_tool_use' }, { type: 'text', text: '' }, 'loose'] } })).toEqual([
      t('assistant.content=server_tool_use'),
      t('assistant.content=(missing)'),
    ]);
    expect(transcriptDrifts({ type: 'user', message: { content: [{ type: 'audio' }] } })).toEqual([t('user.content=audio')]);
  });
});

describe('transcriptWatcher', () => {
  it('since より古い版の行と、版の分からない行は見ない。版の無い行は直前の行の版を継ぐ', () => {
    const seen: Drift[] = [];
    const watch = transcriptWatcher({ sink: { note: (d) => seen.push(d) }, since: () => '2.1.292' });
    watch({ type: 'old-meta' });
    watch({ type: 'user', message: { content: 'x' }, version: '2.1.100' });
    watch({ type: 'old-meta' });
    watch({ type: 'system', subtype: 'turn_end', version: '2.1.300' });
    watch({ type: 'new-meta' });
    watch({ type: 'system', subtype: 'turn_end2', version: '2.1.292' });
    expect(seen).toEqual([
      { contract: 'transcript', value: 'system.subtype=turn_end', version: '2.1.300' },
      { contract: 'transcript', value: 'type=new-meta', version: '2.1.300' },
      { contract: 'transcript', value: 'system.subtype=turn_end2', version: '2.1.292' },
    ]);
  });
});
