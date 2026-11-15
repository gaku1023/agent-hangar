import { describe, expect, it } from 'vitest';
import { isVoiceEvent } from './voice.ts';

describe('isVoiceEvent', () => {
  it('約束どおりの形の行を受ける', () => {
    for (const e of [
      { ev: 'ready', version: '1' },
      { ev: 'models', state: 'downloading', progress: 0.4 },
      { ev: 'models', state: 'failed', progress: 0, message: 'x' },
      { ev: 'vad', speech: true },
      { ev: 'segment', id: 's', text: 'こんにちは', dbfs: -30, ms: 500 },
      { ev: 'flushed' },
      { ev: 'speaking', id: 'r1', state: 'end' },
      { ev: 'micUsers', bundles: ['us.zoom.xos'] },
      { ev: 'error', code: 'x', message: 'y' },
    ]) expect(isVoiceEvent(e), JSON.stringify(e)).toBe(true);
  });

  it('ev を持っていても形が合わない行は断る', () => {
    for (const e of [
      null, 'x', [1], { nope: 1 }, { ev: 1 }, { ev: 'unknown' },
      { ev: 'ready' },
      { ev: 'models', state: 'weird', progress: 0 },
      { ev: 'models', state: 'ready', progress: Number.NaN },
      { ev: 'vad', speech: 'yes' },
      { ev: 'segment' },
      { ev: 'segment', id: 's', text: 1, dbfs: -30, ms: 500 },
      { ev: 'segment', id: 's', text: 'a', dbfs: '-30', ms: 500 },
      { ev: 'speaking', id: 'r1', state: 'paused' },
      { ev: 'speaking', state: 'end' },
      { ev: 'micUsers' },
      { ev: 'micUsers', bundles: [1] },
      { ev: 'micUsers', bundles: 'zoom' },
      { ev: 'error', code: 1, message: 'y' },
    ]) expect(isVoiceEvent(e), JSON.stringify(e)).toBe(false);
  });
});
