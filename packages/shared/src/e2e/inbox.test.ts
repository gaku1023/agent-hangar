import { describe, expect, it } from 'vitest';
import { fromBase64Url, toBase64Url } from './bytes.ts';
import { INBOX_HEADER_NAMES, INBOX_INFO, INBOX_SEAL_VERSION, generateInboxKeyPair, openFromInbox, sealToInbox, type InboxParcel } from './inbox.ts';
import { E2eOpenError } from './seal.ts';

const parcel: InboxParcel = {
  receivedAt: 1762740000000,
  headers: {
    'x-github-event': 'pull_request',
    'x-github-delivery': '0b1c2d3e-0000-4000-8000-000000000001',
    'x-hub-signature-256': 'sha256=00ff',
    'content-type': 'application/json',
  },
  body: JSON.stringify({ action: 'opened', number: 12 }),
};

// 封の base64url の部分の 1 バイトを変える。
function flipByte(sealed: string, at: number): string {
  const dot = sealed.indexOf('.');
  const bytes = fromBase64Url(sealed.slice(dot + 1))!;
  bytes[at] = bytes[at]! ^ 0x01;
  return `${sealed.slice(0, dot)}.${toBase64Url(bytes)}`;
}

describe('受け箱の封', () => {
  it('info と版の値', () => {
    expect(INBOX_INFO).toBe('hangar-inbox-v1');
    expect(INBOX_SEAL_VERSION).toBe('1');
    expect(INBOX_HEADER_NAMES).toEqual(['x-github-event', 'x-github-delivery', 'x-hub-signature-256', 'content-type']);
  });

  it('鍵の対はどちらも 32 バイトの base64url', async () => {
    const k = await generateInboxKeyPair();
    expect(fromBase64Url(k.publicKey)?.length).toBe(32);
    expect(fromBase64Url(k.privateKey)?.length).toBe(32);
  });

  it('round trips a parcel', async () => {
    const k = await generateInboxKeyPair();
    const sealed = await sealToInbox(k.publicKey, 'inbox-a', parcel);
    expect(sealed).toMatch(/^1\.[A-Za-z0-9_-]+$/);
    expect(await openFromInbox(k.privateKey, 'inbox-a', sealed)).toEqual(parcel);
  });

  it('大きな本文も戻る', async () => {
    const k = await generateInboxKeyPair();
    const big = { ...parcel, body: 'あ'.repeat(20_000) };
    const sealed = await sealToInbox(k.publicKey, 'inbox-a', big);
    expect(await openFromInbox(k.privateKey, 'inbox-a', sealed)).toEqual(big);
  });

  it('rejects another inbox id', async () => {
    const k = await generateInboxKeyPair();
    const sealed = await sealToInbox(k.publicKey, 'inbox-a', parcel);
    await expect(openFromInbox(k.privateKey, 'inbox-b', sealed)).rejects.toBeInstanceOf(E2eOpenError);
  });

  it('別の受け箱の秘密鍵では開けない', async () => {
    const k = await generateInboxKeyPair();
    const other = await generateInboxKeyPair();
    const sealed = await sealToInbox(k.publicKey, 'inbox-a', parcel);
    await expect(openFromInbox(other.privateKey, 'inbox-a', sealed)).rejects.toBeInstanceOf(E2eOpenError);
  });

  it('rejects a tampered seal', async () => {
    const k = await generateInboxKeyPair();
    const sealed = await sealToInbox(k.publicKey, 'inbox-a', parcel);
    const len = fromBase64Url(sealed.slice(2))!.length;
    // 使い捨ての公開鍵、IV、暗号文の中、認証の印のどこを変えても開けない。
    for (const at of [0, 31, 32, 40, 50, len - 1]) {
      await expect(openFromInbox(k.privateKey, 'inbox-a', flipByte(sealed, at))).rejects.toBeInstanceOf(E2eOpenError);
    }
  });

  it('版や形の違う文字列は開けない', async () => {
    const k = await generateInboxKeyPair();
    const sealed = await sealToInbox(k.publicKey, 'inbox-a', parcel);
    for (const bad of [`2${sealed.slice(1)}`, sealed.slice(2), `${sealed}.x`, '1.', '1.!!!', '', sealed.slice(0, 40)]) {
      await expect(openFromInbox(k.privateKey, 'inbox-a', bad)).rejects.toBeInstanceOf(E2eOpenError);
    }
  });

  it('uses a fresh ephemeral key each time', async () => {
    const k = await generateInboxKeyPair();
    const a = await sealToInbox(k.publicKey, 'inbox-a', parcel);
    const b = await sealToInbox(k.publicKey, 'inbox-a', parcel);
    expect(a).not.toBe(b);
    // 頭の 32 バイト（使い捨ての公開鍵）が違う。
    expect(toBase64Url(fromBase64Url(a.slice(2))!.subarray(0, 32))).not.toBe(toBase64Url(fromBase64Url(b.slice(2))!.subarray(0, 32)));
  });

  it('見出しは小文字にし、決まった 4 つだけを封じる', async () => {
    const k = await generateInboxKeyPair();
    const sealed = await sealToInbox(k.publicKey, 'inbox-a', {
      receivedAt: 1,
      headers: { 'X-GitHub-Event': 'push', Authorization: 'secret', 'Content-Type': 'application/json', cookie: 'c' },
      body: '{}',
    });
    expect(await openFromInbox(k.privateKey, 'inbox-a', sealed)).toEqual({
      receivedAt: 1,
      headers: { 'x-github-event': 'push', 'content-type': 'application/json' },
      body: '{}',
    });
  });

  it('公開鍵の形が違えば封じない', async () => {
    await expect(sealToInbox('short', 'inbox-a', parcel)).rejects.toBeInstanceOf(TypeError);
  });
});
