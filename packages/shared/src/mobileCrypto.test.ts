import { describe, expect, it } from 'vitest';
import { deriveFileKey } from '../../server/src/sync/crypto.ts';
import {
  MobileOpenError,
  MobilePairingError,
  aadAnswer,
  aadAsk,
  aadFeed,
  aadImage,
  aadLaunch,
  aadReply,
  decodePairing,
  deriveMobileKey,
  deriveMobileKeyBytes,
  encodePairing,
  importMobileKey,
  isRemoteControlUrl,
  open,
  openBytes,
  seal,
  sealBytes,
  type PairingBlob,
} from './mobileCrypto.ts';
import * as shared from './index.ts';

const SECRET = 'join-secret-for-tests-a';

describe('スマホ用の鍵と封じ（seal / open）', () => {
  it('seal→open で元の値に戻る', async () => {
    const key = await deriveMobileKey(SECRET);
    const value = { v: 1, deviceId: 'pc-1', live: [{ title: '会話 1', n: 3 }], nothing: null };
    const sealed = await seal(key, aadFeed('pc-1'), value);
    expect(typeof sealed).toBe('string');
    expect(sealed).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(await open(key, aadFeed('pc-1'), sealed)).toEqual(value);
  });

  it('AAD が違うと open が MobileOpenError を投げる', async () => {
    const key = await deriveMobileKey(SECRET);
    const sealed = await seal(key, aadFeed('a'), { x: 1 });
    await expect(open(key, aadFeed('b'), sealed)).rejects.toBeInstanceOf(MobileOpenError);
    await expect(open(key, aadAnswer('a'), sealed)).rejects.toBeInstanceOf(MobileOpenError);
  });

  it('別の joinSecret の鍵では開けない', async () => {
    const a = await deriveMobileKey(SECRET);
    const b = await deriveMobileKey('another-secret');
    const sealed = await seal(a, aadFeed('pc-1'), { x: 1 });
    await expect(open(b, aadFeed('pc-1'), sealed)).rejects.toBeInstanceOf(MobileOpenError);
  });

  it('同じ値を 2 回封じると別の文字列になる（IV は乱数）', async () => {
    const key = await deriveMobileKey(SECRET);
    const s1 = await seal(key, aadFeed('pc-1'), { x: 1 });
    const s2 = await seal(key, aadFeed('pc-1'), { x: 1 });
    expect(s1).not.toBe(s2);
  });

  it('壊れた文字列や短すぎる文字列は MobileOpenError', async () => {
    const key = await deriveMobileKey(SECRET);
    await expect(open(key, aadFeed('pc-1'), '')).rejects.toBeInstanceOf(MobileOpenError);
    await expect(open(key, aadFeed('pc-1'), 'abc')).rejects.toBeInstanceOf(MobileOpenError);
    await expect(open(key, aadFeed('pc-1'), '!!!not base64!!!')).rejects.toBeInstanceOf(MobileOpenError);
    const sealed = await seal(key, aadFeed('pc-1'), { x: 1 });
    const tampered = sealed.slice(0, -2) + (sealed.endsWith('A') ? 'BB' : 'AA');
    await expect(open(key, aadFeed('pc-1'), tampered)).rejects.toBeInstanceOf(MobileOpenError);
  });

  it('importMobileKey(deriveMobileKeyBytes(s)) で封じたものを deriveMobileKey(s) で開ける', async () => {
    const bytes = await deriveMobileKeyBytes(SECRET);
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.length).toBe(32);
    const imported = await importMobileKey(bytes);
    const sealed = await seal(imported, aadAnswer('r1'), { ok: true });
    const derived = await deriveMobileKey(SECRET);
    expect(await open(derived, aadAnswer('r1'), sealed)).toEqual({ ok: true });
  });

  it('既定の import は exportKey できない（extractable を明示したときだけ取り出せる）', async () => {
    const bytes = await deriveMobileKeyBytes(SECRET);
    const locked = await importMobileKey(bytes);
    expect(locked.extractable).toBe(false);
    await expect(crypto.subtle.exportKey('raw', locked)).rejects.toBeTruthy();
    const unlocked = await importMobileKey(bytes, true);
    expect(new Uint8Array(await crypto.subtle.exportKey('raw', unlocked))).toEqual(bytes);
    const derived = await deriveMobileKey(SECRET);
    expect(derived.extractable).toBe(false);
  });

  it('R2 の鍵と別物である（同じ秘密のファイル鍵では開けない）', async () => {
    const mobile = await deriveMobileKey(SECRET);
    const sealed = await seal(mobile, aadFeed('pc-1'), { x: 1 });
    const fileKey = await crypto.subtle.importKey('raw', new Uint8Array(deriveFileKey(SECRET)), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
    await expect(open(fileKey, aadFeed('pc-1'), sealed)).rejects.toBeInstanceOf(MobileOpenError);
    const bytes = await deriveMobileKeyBytes(SECRET);
    expect(Buffer.from(bytes).equals(deriveFileKey(SECRET))).toBe(false);
  });

  it('AAD の作り方', () => {
    expect(aadFeed('pc-1')).toBe('feed:pc-1');
    expect(aadLaunch('req-1', 'pc-2')).toBe('launch:req-1:pc-2');
    expect(aadAnswer('req-1')).toBe('answer:req-1');
    expect(aadAsk('q-1', 'pc-2')).toBe('ask:q-1:pc-2');
    expect(aadReply('q-1')).toBe('reply:q-1');
    expect(aadImage('req-1', 2)).toBe('image:req-1:2');
  });
});

describe('バイト列の封じ（sealBytes / openBytes）', () => {
  it('往復で元に戻り、形は IV 12 バイトと暗号文とタグ 16 バイト', async () => {
    const key = await deriveMobileKey(SECRET);
    const plain = Uint8Array.from({ length: 1000 }, (_, i) => i % 251);
    const sealed = await sealBytes(key, aadImage('r1', 0), plain);
    expect(sealed).toBeInstanceOf(Uint8Array);
    expect(sealed.length).toBe(12 + plain.length + 16);
    expect(Array.from(await openBytes(key, aadImage('r1', 0), sealed))).toEqual(Array.from(plain));
  });

  it('空のバイト列も往復でき、IV は毎回変わる', async () => {
    const key = await deriveMobileKey(SECRET);
    const a = await sealBytes(key, aadImage('r1', 0), new Uint8Array());
    const b = await sealBytes(key, aadImage('r1', 0), new Uint8Array());
    expect(a.length).toBe(28);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
    expect((await openBytes(key, aadImage('r1', 0), a)).length).toBe(0);
  });

  it('AAD が違うもの（別の依頼、別の番号、別の用途）と、別の鍵と、壊れたものは MobileOpenError', async () => {
    const key = await deriveMobileKey(SECRET);
    const other = await deriveMobileKey(SECRET + 'x');
    const sealed = await sealBytes(key, aadImage('r1', 0), new Uint8Array([1, 2, 3]));
    await expect(openBytes(key, aadImage('r2', 0), sealed)).rejects.toBeInstanceOf(MobileOpenError);
    await expect(openBytes(key, aadImage('r1', 1), sealed)).rejects.toBeInstanceOf(MobileOpenError);
    await expect(openBytes(key, aadReply('r1'), sealed)).rejects.toBeInstanceOf(MobileOpenError);
    await expect(openBytes(other, aadImage('r1', 0), sealed)).rejects.toBeInstanceOf(MobileOpenError);
    await expect(openBytes(key, aadImage('r1', 0), new Uint8Array(5))).rejects.toBeInstanceOf(MobileOpenError);
    const tampered = sealed.slice();
    tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 1;
    await expect(openBytes(key, aadImage('r1', 0), tampered)).rejects.toBeInstanceOf(MobileOpenError);
  });

  it('問い合わせの AAD は宛先と ID で縛る（seal / open でも同じ）', async () => {
    const key = await deriveMobileKey(SECRET);
    const sealed = await seal(key, aadAsk('q1', 'pc-1'), { kind: 'files' });
    expect(await open(key, aadAsk('q1', 'pc-1'), sealed)).toEqual({ kind: 'files' });
    await expect(open(key, aadAsk('q1', 'pc-2'), sealed)).rejects.toBeInstanceOf(MobileOpenError);
    await expect(open(key, aadReply('q1'), sealed)).rejects.toBeInstanceOf(MobileOpenError);
  });
});

describe('ペアリングの文字列', () => {
  const blob: PairingBlob = { url: 'https://hangar-sync.example.workers.dev', code: 'c0de-1234', key: 'a2V5LWJ5dGVz', pcName: 'PC あ', expiresAt: 1_790_000_000_000 };

  it('decodePairing(encodePairing(b)) が元に戻る', () => {
    const s = encodePairing(blob);
    expect(s).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodePairing(s)).toEqual(blob);
  });

  it('壊れた文字列は MobilePairingError', () => {
    expect(() => decodePairing('')).toThrow(MobilePairingError);
    expect(() => decodePairing('%%%')).toThrow(MobilePairingError);
    expect(() => decodePairing(encodePairing(blob).slice(0, 10))).toThrow(MobilePairingError);
    const noJson = btoa('not json').replace(/=+$/, '');
    expect(() => decodePairing(noJson)).toThrow(MobilePairingError);
    const missing = btoa(JSON.stringify({ url: 'https://x.example', code: 'c' })).replace(/=+$/, '');
    expect(() => decodePairing(missing)).toThrow(MobilePairingError);
    const wrongType = btoa(JSON.stringify({ ...blob, pcName: 'pc', expiresAt: 'soon' })).replace(/=+$/, '');
    expect(() => decodePairing(wrongType)).toThrow(MobilePairingError);
  });
});

describe('isRemoteControlUrl', () => {
  it('https://claude.ai/ で始まる URL だけ true', () => {
    expect(isRemoteControlUrl('https://claude.ai/code/x')).toBe(true);
    expect(isRemoteControlUrl('https://claude.ai/code/session_abc123')).toBe(true);
    expect(isRemoteControlUrl('javascript:alert(1)')).toBe(false);
    expect(isRemoteControlUrl('https://claude.ai.evil.example/')).toBe(false);
    expect(isRemoteControlUrl('http://claude.ai/')).toBe(false);
    expect(isRemoteControlUrl('https://claude.ai@evil.example/')).toBe(false);
    expect(isRemoteControlUrl('https://claude.ai')).toBe(false);
    expect(isRemoteControlUrl('')).toBe(false);
  });
});

describe('パッケージの入口', () => {
  it('shared の入口から取れる', () => {
    expect(shared.seal).toBe(seal);
    expect(shared.PERMISSION_MODE_VALUES).toEqual(['', 'plan', 'manual', 'acceptEdits', 'auto', 'dontAsk', 'bypassPermissions']);
    expect(shared.MODEL_CHOICES).toEqual(['fable', 'opus', 'sonnet', 'haiku']);
  });
});
