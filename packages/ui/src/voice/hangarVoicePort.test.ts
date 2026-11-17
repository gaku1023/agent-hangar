import type { VoiceStateDto } from '@agent-hangar/shared';
import { describe, expect, it, vi } from 'vitest';
import { hangarVoicePort } from './hangarVoicePort.ts';

const st = (o: Partial<VoiceStateDto> = {}): VoiceStateDto => ({ available: true, models: { state: 'ready', progress: 1 }, mode: 'off', phase: 'off', caption: null, speakingId: null, toggled: false, meeting: false, callable: true, ...o });
const api = () => ({ voiceSpeak: vi.fn(async () => ({})), voiceStop: vi.fn(async () => ({})) });

describe('hangarVoicePort', () => {
  it('canListen と canSpeak は available に従う', () => {
    const p = hangarVoicePort(api());
    expect(p.canListen()).toBe(false);
    p.update(st());
    expect(p.canListen()).toBe(true);
    expect(p.canSpeak()).toBe(true);
    p.update(st({ available: false }));
    expect(p.canSpeak()).toBe(false);
  });
  it('speak は POST /api/voice/speak へ id と文を渡す', async () => {
    const a = api();
    const p = hangarVoicePort(a);
    p.update(st());
    await p.speak('こんにちは', 'ja');
    expect(a.voiceSpeak).toHaveBeenCalledWith(expect.stringMatching(/^ui-/), 'こんにちは');
  });
  it('speaking は speakingId から作り、読み終わった時刻を覚える', () => {
    const p = hangarVoicePort(api(), () => 5000);
    p.update(st({ speakingId: 'ui-1' }));
    expect(p.speaking()).toBe(true);
    expect(p.lastSpokenEnd()).toBe(0);
    p.update(st({ speakingId: null }));
    expect(p.speaking()).toBe(false);
    expect(p.lastSpokenEnd()).toBe(5000);
  });
  it('cancel は読み上げを止め、終わった時刻を 0 に戻す', () => {
    const a = api();
    const p = hangarVoicePort(a, () => 5000);
    p.update(st({ speakingId: 'ui-1' }));
    p.update(st({ speakingId: null }));
    p.cancel();
    expect(a.voiceStop).toHaveBeenCalled();
    expect(p.lastSpokenEnd()).toBe(0);
  });
});
