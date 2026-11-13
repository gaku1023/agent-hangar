import { describe, expect, it } from 'vitest';
import { FakeVoicePort } from './fakeVoicePort.ts';
import { createSpeaker } from './speaker.ts';

describe('createSpeaker', () => {
  it('返答の文を言語に合わせて speak する', () => {
    const port = new FakeVoicePort();
    createSpeaker(port, () => 'ja').speak('終わりました');
    expect(port.calls).toEqual(['speak:ja:終わりました']);
  });
  it('空の文は読まない', () => {
    const port = new FakeVoicePort();
    createSpeaker(port, () => 'en').speak('  ');
    expect(port.calls).toEqual([]);
  });
  it('読めない環境では何もしない', () => {
    const port = new FakeVoicePort();
    port.canSpeakNow = false;
    const s = createSpeaker(port, () => 'en');
    s.speak('x');
    s.stop();
    expect(port.calls).toEqual([]);
  });
  it('stop は cancel を呼ぶ', () => {
    const port = new FakeVoicePort();
    createSpeaker(port, () => 'en').stop();
    expect(port.calls).toEqual(['cancel']);
  });
  it('新しい文を読む前に、読み上げ中のものを止める', () => {
    const port = new FakeVoicePort();
    const s = createSpeaker(port, () => 'en');
    s.speak('a');
    s.speak('b');
    expect(port.calls).toEqual(['speak:en:a', 'cancel', 'speak:en:b']);
  });
});
