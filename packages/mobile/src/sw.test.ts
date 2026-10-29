import fs from 'node:fs';
import path from 'node:path';
import type { PhoneNotice } from '@agent-hangar/shared/src/mobile.ts';
import { openPhoneNotice, sealPhoneNotice } from '@agent-hangar/shared/src/mobileCrypto.ts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearPhoneKeys, savePhoneKey } from './store.ts';
import { makeKey, randomKeyBytes } from './test/fixtures.ts';

// public/sw.js は素の JS で、shared の TS を読めない。
// ここでは偽の self の上で sw.js をそのまま走らせ、shared の sealPhoneNotice で封じたものを sw.js の手順で開けることを確かめる。
const code = fs.readFileSync(path.resolve(import.meta.dirname, '../public/sw.js'), 'utf8');
const ORIGIN = 'https://hangar.example.workers.dev';
const GENERIC = 'hangar に新しい知らせがあります';

type Shown = { title: string; options: NotificationOptions & { data?: unknown } };
type Win = { url: string; focused: boolean; messages: unknown[]; focus: () => Promise<Win>; postMessage: (m: unknown) => void };

function boot(windows: Win[] = []) {
  const handlers: Record<string, (e: unknown) => void> = {};
  const shown: Shown[] = [];
  const opened: string[] = [];
  const self = {
    location: { href: `${ORIGIN}/app/sw.js`, origin: ORIGIN },
    addEventListener: (type: string, f: (e: unknown) => void) => {
      handlers[type] = f;
    },
    skipWaiting: () => undefined,
    indexedDB: globalThis.indexedDB,
    crypto: globalThis.crypto,
    registration: {
      showNotification: async (title: string, options: NotificationOptions) => {
        shown.push({ title, options });
      },
    },
    clients: {
      claim: async () => undefined,
      matchAll: async () => windows,
      openWindow: async (url: string) => {
        opened.push(url);
        return null;
      },
    },
  };
  new Function('self', code)(self);
  return { handlers, shown, opened };
}

/** push の出来事を渡して、waitUntil に渡された仕事が終わるまで待つ。 */
async function push(h: ReturnType<typeof boot>, text: string | null): Promise<void> {
  let job: Promise<unknown> = Promise.resolve();
  h.handlers.push!({ data: text === null ? null : { text: () => text }, waitUntil: (p: Promise<unknown>) => (job = p) });
  await job;
}

const notice = (p: Partial<PhoneNotice> = {}): PhoneNotice => ({ title: '会話 a', pcName: 'pc-a', sessionId: 's-1', count: 1, ...p });

beforeEach(async () => {
  await clearPhoneKeys();
});

afterEach(async () => {
  await clearPhoneKeys();
});

describe('sw.js と store.ts の IndexedDB', () => {
  it('DB の名前と版がそろっている（store.ts だけ版を上げると、sw.js が鍵を読めず題の無い汎用の通知になる）', () => {
    const store = fs.readFileSync(path.resolve(import.meta.dirname, 'store.ts'), 'utf8');
    const nameOf = (s: string) => /const DB_NAME = '([^']+)'/.exec(s)?.[1];
    const versionOf = (s: string) => /\.open\(DB_NAME, (\d+)\)/.exec(s)?.[1];
    expect(nameOf(code)).toBe(nameOf(store));
    expect(versionOf(code)).toBeDefined();
    expect(versionOf(code)).toBe(versionOf(store));
  });
});

describe('sw.js の push', () => {
  it('shared の sealPhoneNotice で封じた通知を、手元の M[世代] で開いて出す', async () => {
    const key = await makeKey();
    await savePhoneKey(2, key);
    const h = boot();
    await push(h, await sealPhoneNotice(key, 2, notice()));
    expect(h.shown).toHaveLength(1);
    expect(h.shown[0]!.title).toBe('会話 a');
    expect(h.shown[0]!.options.body).toBe('pc-a で入力を待っています');
    expect(h.shown[0]!.options.data).toEqual({ sessionId: 's-1' });
  });

  it('生の 32 バイトで封じても、取り出せない鍵で開ける', async () => {
    const raw = randomKeyBytes();
    await savePhoneKey(1, await makeKey(raw));
    const h = boot();
    await push(h, await sealPhoneNotice(raw, 1, notice({ title: '題', pcName: 'pc-b' })));
    expect(h.shown[0]).toMatchObject({ title: '題', options: { body: 'pc-b で入力を待っています' } });
  });

  it('2 件以上なら見出しが「〈題〉ほか n 件」', async () => {
    const key = await makeKey();
    await savePhoneKey(1, key);
    const h = boot();
    await push(h, await sealPhoneNotice(key, 1, notice({ count: 3 })));
    expect(h.shown[0]!.title).toBe('会話 a ほか 2 件');
  });

  it('未読（kind unread）は、題を会話の名前、本文を body にし、「ほか n 件」を付けない。押したときの開き先は同じ', async () => {
    const key = await makeKey();
    await savePhoneKey(1, key);
    const h = boot();
    await push(h, await sealPhoneNotice(key, 1, notice({ kind: 'unread', body: 'テストが通りました', count: 3 })));
    expect(h.shown[0]!.title).toBe('会話 a');
    expect(h.shown[0]!.options.body).toBe('テストが通りました');
    expect(h.shown[0]!.options.data).toEqual({ sessionId: 's-1' });
  });

  it('kind が waiting なら body があっても入力待ちとして読む', async () => {
    const key = await makeKey();
    await savePhoneKey(1, key);
    const h = boot();
    await push(h, await sealPhoneNotice(key, 1, notice({ kind: 'waiting', body: '無視される' })));
    expect(h.shown[0]!.options.body).toBe('pc-a で入力を待っています');
  });

  it('世代の合う鍵を選ぶ（古い世代と新しい世代が両方ある）', async () => {
    const old = await makeKey();
    const next = await makeKey();
    await savePhoneKey(1, old);
    await savePhoneKey(2, next);
    const h = boot();
    await push(h, await sealPhoneNotice(old, 1, notice({ title: '古い世代' })));
    expect(h.shown[0]!.title).toBe('古い世代');
  });

  it.each([
    ['鍵が無い', async () => sealPhoneNotice(await makeKey(), 1, notice())],
    ['世代の鍵が無い', async () => {
      const key = await makeKey();
      await savePhoneKey(1, key);
      return sealPhoneNotice(key, 2, notice());
    }],
    ['鍵が違う', async () => {
      await savePhoneKey(1, await makeKey());
      return sealPhoneNotice(await makeKey(), 1, notice());
    }],
    ['頭の世代を書き換えた', async () => {
      const key = await makeKey();
      await savePhoneKey(1, key);
      await savePhoneKey(2, key);
      return (await sealPhoneNotice(key, 1, notice())).replace(/^1\./, '2.');
    }],
    ['形が違う', async () => 'not-a-notice'],
    ['base64url が壊れている', async () => '1.a'],
    ['本文が無い', async () => null],
  ])('開けないとき（%s）は汎用の文で必ず出す', async (_, make) => {
    const text = await make();
    const h = boot();
    await push(h, text);
    expect(h.shown).toHaveLength(1);
    expect(h.shown[0]!.title).toBe('hangar');
    expect(h.shown[0]!.options.body).toBe(GENERIC);
    expect(h.shown[0]!.options.data).toEqual({ sessionId: null });
  });

  it('同じ会話の知らせは tag で重ね、鳴らし直す', async () => {
    const key = await makeKey();
    await savePhoneKey(1, key);
    const h = boot();
    await push(h, await sealPhoneNotice(key, 1, notice()));
    expect(h.shown[0]!.options.tag).toBe('session:s-1');
    expect((h.shown[0]!.options as { renotify?: boolean }).renotify).toBe(true);
  });

  it('shared の openPhoneNotice と同じものを読む（相互運用）', async () => {
    const key = await makeKey();
    await savePhoneKey(5, key);
    const sealed = await sealPhoneNotice(key, 5, notice({ title: 'x'.repeat(200), pcName: 'pc-c', sessionId: 's-9', count: 2 }));
    const opened = await openPhoneNotice(key, sealed);
    const h = boot();
    await push(h, sealed);
    expect(h.shown[0]!.title).toBe(`${opened.title} ほか 1 件`);
    expect(h.shown[0]!.options.data).toEqual({ sessionId: opened.sessionId });
  });
});

describe('sw.js の notificationclick', () => {
  const click = async (h: ReturnType<typeof boot>, data: unknown): Promise<{ closed: boolean }> => {
    const note = { closed: false, data, close() {
      this.closed = true;
    } };
    let job: Promise<unknown> = Promise.resolve();
    h.handlers.notificationclick!({ notification: note, waitUntil: (p: Promise<unknown>) => (job = p) });
    await job;
    return note;
  };

  it('開いている hangar が無ければ、その会話の行を指して開く', async () => {
    const h = boot();
    const note = await click(h, { sessionId: 's-1/x' });
    expect(note.closed).toBe(true);
    expect(h.opened).toEqual([`${ORIGIN}/app/#open=${encodeURIComponent('s-1/x')}`]);
  });

  it('汎用の知らせなら受信箱を開く', async () => {
    const h = boot();
    await click(h, { sessionId: null });
    expect(h.opened).toEqual([`${ORIGIN}/app/`]);
  });

  it('開いている hangar があれば、前に出して会話の ID を渡す', async () => {
    const win: Win = {
      url: `${ORIGIN}/app/`,
      focused: false,
      messages: [],
      focus: async () => {
        win.focused = true;
        return win;
      },
      postMessage: (m) => win.messages.push(m),
    };
    const h = boot([win]);
    await click(h, { sessionId: 's-2' });
    expect(win.focused).toBe(true);
    expect(win.messages).toEqual([{ type: 'hangar-open', sessionId: 's-2' }]);
    expect(h.opened).toEqual([]);
  });
});
