import { describe, expect, it } from 'vitest';
import { DEFAULT_VOICE_PERSONA, isVoiceEvent, isVoiceId, KOKORO_VOICES, isVoicePatch, voiceOf } from './voice.ts';

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
      { ev: 'voices', os: [] },
      { ev: 'voices', os: [{ id: 'com.apple.voice.compact.ja-JP.Kyoko', name: 'Kyoko' }] },
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
      { ev: 'voices' },
      { ev: 'voices', os: 'x' },
      { ev: 'voices', os: [{ id: 'a' }] },
      { ev: 'voices', os: [{ id: 1, name: 'a' }] },
      { ev: 'voices', os: [null] },
    ]) expect(isVoiceEvent(e), JSON.stringify(e)).toBe(false);
  });
});

const persona = (o: Record<string, unknown>) => ({ id: 'm', name: 'ミナ', reading: 'みな', tone: 'ていねい', voice: 'kokoro:jf_alpha', speed: 1.1, ...o });

describe('人格の値の検証', () => {
  it('PATCH は決まりに合う人格を受ける', () => {
    for (const p of [
      persona({}),
      persona({ reading: '' }),
      persona({ name: 'あ'.repeat(20), reading: 'あ'.repeat(20) }),
      persona({ reading: 'はんがー' }),
      persona({ tone: 'ていねいに。\n短く。\n明るく。\n落ち着いて。' }),
      persona({ tone: 'x'.repeat(300) }),
    ]) expect(isVoicePatch({ personas: [p] }), JSON.stringify(p)).toBe(true);
  });

  it('PATCH は決まりに合わない名前、読み、口調を断る', () => {
    for (const p of [
      persona({ name: '' }),
      persona({ name: 'あ'.repeat(21) }),
      persona({ name: 'ミ\nナ' }),
      persona({ name: 'ミ\u0007ナ' }),
      persona({ reading: 'み' }),
      persona({ reading: 'あ'.repeat(21) }),
      persona({ reading: 'ミナ' }),
      persona({ reading: 'mina' }),
      persona({ reading: 'み\nな' }),
      persona({ reading: 7 }),
      persona({ tone: 'x'.repeat(301) }),
      persona({ tone: 'a\nb\nc\nd\ne' }),
      persona({ tone: 'a\u0000b' }),
      persona({ tone: 'a\rb' }),
    ]) expect(isVoicePatch({ personas: [p] }), JSON.stringify(p)).toBe(false);
  });

  it('読み込みでは合わない値を既定に戻す', () => {
    const v = voiceOf({ personas: [persona({ reading: 'ミナ', tone: 'x'.repeat(301) })] });
    expect(v.personas[0]).toMatchObject({ name: 'ミナ', reading: '', tone: '' });
    const bad = voiceOf({ personas: [persona({ name: 'ミ\nナ' })] });
    expect(bad.personas).toEqual([DEFAULT_VOICE_PERSONA]);
  });
});

describe('isVoiceId', () => {
  it('4 つの形を受け、style id は非負の整数だけ', () => {
    for (const v of ['kokoro:jf_alpha', 'os:com.apple.voice.x', 'voicevox:3', 'voicevox:0', 'aivis:888753760']) expect(isVoiceId(v), v).toBe(true);
    for (const v of ['voicevox:x', 'voicevox:', 'aivis:-1', 'aivis:1.5', 'aivis:1a', 'voicevox:3 ', 'other:1', 'kokoro:', 7, null]) expect(isVoiceId(v), String(v)).toBe(false);
  });
});

describe('voiceLabel', () => {
  it('既定は jf_alpha で、KOKORO_VOICES は 5 つ', () => {
    expect(DEFAULT_VOICE_PERSONA.voiceLabel).toBe('jf_alpha');
    expect(KOKORO_VOICES).toEqual(['jf_alpha', 'jf_gongitsune', 'jf_nezumi', 'jf_tebukuro', 'jm_kumo']);
  });
  it('PATCH は 0〜40 字で制御文字なしの voiceLabel を受け、省けば受ける', () => {
    for (const p of [persona({ voiceLabel: '' }), persona({ voiceLabel: 'VOICEVOX:ずんだもん（あまあま）' }), persona({ voiceLabel: 'あ'.repeat(40) }), persona({})]) expect(isVoicePatch({ personas: [p] }), JSON.stringify(p)).toBe(true);
  });
  it('PATCH は 41 字、制御文字、文字でない値を断る', () => {
    for (const p of [persona({ voiceLabel: 'あ'.repeat(41) }), persona({ voiceLabel: 'a\nb' }), persona({ voiceLabel: 3 })]) expect(isVoicePatch({ personas: [p] }), JSON.stringify(p)).toBe(false);
  });
  it('読み込みでは、合う値は残し、合わない値と無い値は空にする', () => {
    expect(voiceOf({ personas: [persona({ voiceLabel: 'ずんだもん' })] }).personas[0]!.voiceLabel).toBe('ずんだもん');
    expect(voiceOf({ personas: [persona({ voiceLabel: 'あ'.repeat(41) })] }).personas[0]!.voiceLabel).toBe('');
    expect(voiceOf({ personas: [persona({ voiceLabel: 'a\u0007' })] }).personas[0]!.voiceLabel).toBe('');
    expect(voiceOf({ personas: [persona({})] }).personas[0]!.voiceLabel).toBe('');
    expect(voiceOf({ personas: [persona({ voice: 'voicevox:3' })] }).personas[0]!.voice).toBe('voicevox:3');
  });
});
