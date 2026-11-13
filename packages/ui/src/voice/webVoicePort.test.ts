import { describe, expect, it } from 'vitest';
import { speechLang, webVoicePort } from './webVoicePort.ts';

describe('webVoicePort', () => {
  it('認識も合成も無い環境では使えないと答える', () => {
    const port = webVoicePort({} as unknown as Window);
    expect(port.canListen()).toBe(false);
    expect(port.canSpeak()).toBe(false);
  });
  it('webkitSpeechRecognition があれば聞ける', () => {
    class R {}
    expect(webVoicePort({ webkitSpeechRecognition: R } as unknown as Window).canListen()).toBe(true);
  });
  it('言語を BCP47 に直す', () => {
    expect(speechLang('ja')).toBe('ja-JP');
    expect(speechLang('en')).toBe('en-US');
  });
  it('認識の結果を途中と確定に分けて渡し、終わりを知らせる', () => {
    let inst: any;
    class R {
      lang = ''; continuous = false; interimResults = false;
      onresult: ((e: unknown) => void) | null = null; onend: (() => void) | null = null; onerror: ((e: { error: string }) => void) | null = null;
      constructor() { inst = this; }
      start() {} stop() { this.onend?.(); } abort() {}
    }
    const port = webVoicePort({ webkitSpeechRecognition: R } as unknown as Window);
    const log: string[] = [];
    port.listen('ja', { onInterim: (t) => log.push(`i:${t}`), onFinal: (t) => log.push(`f:${t}`), onEnd: () => log.push('end'), onError: (n) => log.push(`e:${n}`) });
    expect(inst.lang).toBe('ja-JP');
    expect(inst.continuous).toBe(true);
    expect(inst.interimResults).toBe(true);
    const res = (t: string, isFinal: boolean) => Object.assign([{ transcript: t }], { isFinal });
    inst.onresult({ resultIndex: 0, results: [res('こん', false)] });
    inst.onresult({ resultIndex: 0, results: [res('こんにちは', true)] });
    inst.onerror({ error: 'not-allowed' });
    inst.onend();
    expect(log).toEqual(['i:こん', 'f:こんにちは', 'e:not-allowed', 'end']);
  });
});
