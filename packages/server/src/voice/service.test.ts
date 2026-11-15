import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { voiceOf, type OrchestratorOrigin, type VoiceCommand, type VoiceEvent, type VoiceSetting } from '@agent-hangar/shared';
import { VoiceService, type VoiceServiceDeps } from './service.ts';

class FakeHelper extends EventEmitter {
  status: 'unavailable' | 'starting' | 'ready' | 'crashed' = 'unavailable';
  cmds: VoiceCommand[] = [];
  started = 0;
  start() { this.started++; this.status = 'ready'; }
  send(c: VoiceCommand) { this.cmds.push(c); }
  async stop() { this.status = 'unavailable'; }
  ev(e: VoiceEvent) { this.emit('event', e); }
  cmdsOf<K extends VoiceCommand['cmd']>(k: K) { return this.cmds.filter((c) => c.cmd === k) as Extract<VoiceCommand, { cmd: K }>[]; }
}

let now = 1_000_000;
let tickFn: () => void = () => {};
let helper: FakeHelper;
let sent: { text: string; origin: OrchestratorOrigin }[];
let broadcasts: unknown[];
let voice: VoiceSetting;
let assistantSeq: number | null;

const tick = (ms: number) => { now += ms; tickFn(); };
function make(over: Partial<VoiceServiceDeps> = {}): VoiceService {
  const svc = new VoiceService({
    helper: helper as unknown as VoiceServiceDeps['helper'],
    hasHelper: true,
    settings: () => ({ voice, orchestratorSessionId: 'orch-1' }),
    send: async (text, origin) => { sent.push({ text, origin }); return true; },
    broadcast: (e) => { broadcasts.push(e); },
    hintSource: () => ({ sessionTitles: ['調べもの'], projectNames: ['alpha'] }),
    latestAssistantSeq: () => assistantSeq,
    now: () => now,
    timers: { setInterval: (f) => { tickFn = f; return 1 as unknown as NodeJS.Timeout; }, clearInterval: () => {} },
    ...over,
  });
  svc.start();
  return svc;
}
const seg = (text: string, dbfs = -30) => helper.ev({ ev: 'segment', id: 's', text, dbfs, ms: 500 });

beforeEach(() => {
  now = 1_000_000;
  helper = new FakeHelper();
  sent = [];
  broadcasts = [];
  assistantSeq = 0;
  voice = voiceOf({ mode: 'always' });
});

describe('声のサービス', () => {
  it('呼びかけ語つきの区間が voice-called で 1 回送られる', async () => {
    make();
    seg('ねえハンガー、進み具合は');
    await vi.waitFor(() => expect(sent).toEqual([{ text: '進み具合は', origin: 'voice-called' }]));
  });

  it('dbfs -50 の区間と定番の作り話は送られない', async () => {
    make();
    seg('ねえハンガー、進み具合は', -50);
    seg('ご視聴ありがとうございました');
    await Promise.resolve();
    expect(sent).toEqual([]);
  });

  it('常に聞くでも、呼びかけ語の無い区間は送られない', async () => {
    make();
    seg('今日の夕飯はカレーにしよう');
    await Promise.resolve();
    expect(sent).toEqual([]);
  });

  it('補助は always のとき起こし、off のときは hold が来るまで起こさない', () => {
    voice = voiceOf({ mode: 'always' });
    make();
    expect(helper.started).toBe(1);
    expect(helper.cmdsOf('listen').at(-1)).toEqual({ cmd: 'listen', on: true });
    helper = new FakeHelper();
    voice = voiceOf({ mode: 'off' });
    const svc = make();
    expect(helper.started).toBe(0);
    svc.hold(true);
    expect(helper.started).toBe(1);
  });

  it('離すと flush を送り、flushed を受けてから 1 本にまとめて 1 回だけ送る', async () => {
    voice = voiceOf({ mode: 'off' });
    const svc = make();
    svc.hold(true);
    expect(helper.cmdsOf('listen').at(-1)).toEqual({ cmd: 'listen', on: true });
    seg('進み具合を');
    svc.hold(false);
    expect(helper.cmdsOf('flush')).toHaveLength(1);
    await Promise.resolve();
    expect(sent).toEqual([]);
    seg('教えて');
    helper.ev({ ev: 'flushed' });
    await vi.waitFor(() => expect(sent).toEqual([{ text: '進み具合を 教えて', origin: 'voice-held' }]));
    expect(helper.cmdsOf('listen').at(-1)).toEqual({ cmd: 'listen', on: false });
  });

  it('flushed が来なくても 3 秒で離した扱いにする', async () => {
    voice = voiceOf({ mode: 'off' });
    const svc = make();
    svc.hold(true);
    seg('おはよう');
    svc.hold(false);
    tick(3500);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
  });

  it('返答の到着で窓が開き、読み上げが終わった時刻から 10 秒の間の区間が voice-window で送られる', async () => {
    const svc = make();
    seg('ねえハンガー、調べて');
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    assistantSeq = 6;
    svc.onTranscriptAppended('orch-1');
    svc.speak('r1', '調べました');
    helper.ev({ ev: 'speaking', id: 'r1', state: 'start' });
    expect(svc.state().speakingId).toBe('r1');
    tick(4000);
    helper.ev({ ev: 'speaking', id: 'r1', state: 'end' });
    expect(svc.state().phase).toBe('window');
    tick(9000);
    seg('続きをお願い');
    await vi.waitFor(() => expect(sent.at(-1)).toEqual({ text: '続きをお願い', origin: 'voice-window' }));
  });

  it('読み上げが来なければ返答の到着の時刻から窓が数える', async () => {
    const svc = make();
    seg('ねえハンガー、調べて');
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    assistantSeq = 2;
    svc.onTranscriptAppended('orch-1');
    tick(2000);
    expect(svc.state().phase).toBe('window');
    tick(9000);
    expect(svc.state().phase).toBe('ambient');
  });

  it('統括の会話以外の追記と、assistant でない追記は返答にしない', async () => {
    const svc = make();
    seg('ねえハンガー、調べて');
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    // assistant の行は増えていない（利用者や道具の行だけが追記された）。
    svc.onTranscriptAppended('orch-1');
    assistantSeq = 3;
    svc.onTranscriptAppended('other');
    tick(2000);
    tick(2000);
    expect(svc.state().phase).toBe('ambient');
  });

  it('会議（マイクを使う他のプロセス）に入ると会議の段になり、呼びかけ語を受けない', async () => {
    const svc = make();
    helper.ev({ ev: 'micUsers', bundles: ['us.zoom.xos'] });
    expect(svc.state().meeting).toBe(true);
    expect(svc.state().phase).toBe('meeting');
    seg('ねえハンガー、進み具合は');
    await Promise.resolve();
    expect(sent).toEqual([]);
    helper.ev({ ev: 'micUsers', bundles: [] });
    expect(svc.state().meeting).toBe(false);
  });

  it('止めてと言うと、読み上げ中は読み上げを止めて送らない', async () => {
    const svc = make();
    svc.speak('r1', 'ながい返答です');
    helper.ev({ ev: 'speaking', id: 'r1', state: 'start' });
    seg('ストップ');
    await Promise.resolve();
    expect(helper.cmdsOf('stopSpeaking')).toHaveLength(1);
    expect(sent).toEqual([]);
  });

  it('speak は speechText を通した文と人格の声と速さで補助に渡る', () => {
    voice = voiceOf({ mode: 'off', personas: [{ id: 'p', name: 'ミナ', reading: 'みな', tone: '', voice: 'kokoro:jf_alpha', speed: 1.5 }] });
    const svc = make();
    svc.speak('r1', '**太字** です ```code``` https://x.test/a');
    const c = helper.cmdsOf('speak')[0]!;
    expect(c).toMatchObject({ id: 'r1', voice: 'kokoro:jf_alpha', speed: 1.5 });
    expect(c.text).toContain('太字');
    expect(c.text).not.toContain('code');
    expect(c.text).not.toContain('https');
  });

  it('字幕は送った 2 秒後に消える', async () => {
    const svc = make();
    seg('ねえハンガー、進み具合は');
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(svc.state().caption).toBe('進み具合は');
    tick(2100);
    expect(svc.state().caption).toBeNull();
  });

  it('補助が無い環境は available が偽で、動かす口は false を返す', () => {
    const svc = new VoiceService({
      helper: helper as unknown as VoiceServiceDeps['helper'], hasHelper: false,
      settings: () => ({ voice, orchestratorSessionId: null }),
      send: async () => true, broadcast: () => {}, hintSource: () => ({ sessionTitles: [], projectNames: [] }),
      latestAssistantSeq: () => null,
    });
    svc.start();
    expect(svc.state().available).toBe(false);
    expect(svc.hold(true)).toBe(false);
    expect(svc.speak('x', 'y')).toBe(false);
    expect(helper.started).toBe(0);
  });

  it('補助が使えなくなったら（5 回落ちた後）available が偽になる', () => {
    const svc = make();
    expect(svc.state().available).toBe(true);
    helper.status = 'unavailable';
    helper.ev({ ev: 'error', code: 'x', message: 'y' });
    expect(svc.state().available).toBe(false);
  });

  it('ready で語彙のヒントと聞く状態を補助へ送り直し、状態の変化を voice.state で配る', () => {
    make();
    helper.ev({ ev: 'ready', version: '1' });
    const h = helper.cmdsOf('hints').at(-1)!;
    expect(h.context).toContain('alpha');
    expect(h.context).not.toContain('ハンガー');
    expect(broadcasts.some((e) => (e as { type: string }).type === 'voice.state')).toBe(true);
  });

  it('形の合わない出来事が届いても投げず、ログに出して続ける', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const svc = make();
    expect(() => helper.emit('event', { ev: 'micUsers' })).not.toThrow();
    expect(() => helper.emit('event', { ev: 'segment', id: 's', text: 3, dbfs: -30, ms: 1 })).not.toThrow();
    expect(err).toHaveBeenCalled();
    err.mockRestore();
    seg('ねえハンガー、進み具合は');
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(svc.state().available).toBe(true);
  });

  it('モデルの状態を state に載せる', () => {
    const svc = make();
    helper.ev({ ev: 'models', state: 'downloading', progress: 0.4 });
    expect(svc.state().models).toEqual({ state: 'downloading', progress: 0.4 });
  });
});
