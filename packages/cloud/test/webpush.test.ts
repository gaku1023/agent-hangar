import { describe, expect, it } from 'vitest';
import { encryptPushPayload, generateVapidKeys, importVapidKeys, inQuietHours, pushEndpointAllowed, pushRequest, vapidAuthorization } from '../src/webpush.ts';
import { b64u, importEcdhPrivate, newPeer, openPush, recordSizeOf, unb64u, verifyVapid } from './pushPeer.ts';

/**
 * Web Push の暗号（RFC 8291、aes128gcm）と VAPID（RFC 8292）を、Worker の外で確かめる。
 * RFC 8291 の付録 A の試験ベクトルで、送り手の使い捨ての鍵と salt を固定して、本文が 1 バイトも違わないことを縛る。
 */

/** RFC 8291 Appendix A の値。 */
const RFC = {
  plaintext: 'When I grow up, I want to be a watermelon',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  asPublic: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  body: 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
};

const enc = new TextEncoder();

describe('RFC 8291（aes128gcm）', () => {
  it('付録 A の試験ベクトルと同じ本文になる', async () => {
    const asPub = unb64u(RFC.asPublic);
    const asPriv = await importEcdhPrivate(RFC.asPrivate, asPub);
    const asPublicKey = await globalThis.crypto.subtle.importKey('raw', asPub, { name: 'ECDH', namedCurve: 'P-256' }, true, []);
    const body = await encryptPushPayload(enc.encode(RFC.plaintext), unb64u(RFC.uaPublic), unb64u(RFC.auth), { sender: { privateKey: asPriv, publicKey: asPublicKey }, salt: unb64u(RFC.salt) });
    expect(b64u(body)).toBe(RFC.body);
  });

  it('試験の受け手（pushPeer）は付録 A の本文を開ける', async () => {
    const uaPub = unb64u(RFC.uaPublic);
    const priv = await importEcdhPrivate(RFC.uaPrivate, uaPub);
    expect(new TextDecoder().decode(await openPush(unb64u(RFC.body), { priv, pub: uaPub, auth: unb64u(RFC.auth) }))).toBe(RFC.plaintext);
  });

  it('使い捨ての鍵と salt は毎回変わり、受け手の鍵で元に戻る', async () => {
    const peer = await newPeer();
    const payload = enc.encode('3.sealed-notice');
    const a = await encryptPushPayload(payload, peer.pub, peer.auth);
    const b = await encryptPushPayload(payload, peer.pub, peer.auth);
    expect(b64u(a)).not.toBe(b64u(b));
    expect(recordSizeOf(a)).toBe(4096);
    expect(new TextDecoder().decode(await openPush(a, peer))).toBe('3.sealed-notice');
    expect(new TextDecoder().decode(await openPush(b, peer))).toBe('3.sealed-notice');
  });

  it('別の購読の鍵では開けない', async () => {
    const peer = await newPeer();
    const other = await newPeer();
    const body = await encryptPushPayload(enc.encode('x'), peer.pub, peer.auth);
    await expect(openPush(body, { ...other, auth: peer.auth })).rejects.toThrow();
    await expect(openPush(body, { ...peer, auth: other.auth })).rejects.toThrow();
  });

  it('1 つの記録に収まらない本文は断る', async () => {
    const peer = await newPeer();
    await expect(encryptPushPayload(new Uint8Array(4000), peer.pub, peer.auth)).rejects.toThrow(RangeError);
  });
});

describe('VAPID（RFC 8292）', () => {
  it('作った鍵は保存の形から戻せて、公開鍵は 65 バイトの非圧縮点', async () => {
    const stored = await generateVapidKeys();
    expect(unb64u(stored.publicKey)).toHaveLength(65);
    expect(unb64u(stored.publicKey)[0]).toBe(4);
    const keys = await importVapidKeys(JSON.parse(JSON.stringify(stored)));
    expect(keys.publicKey).toBe(stored.publicKey);
  });

  it('JWT は ES256 で、公開鍵で署名が確かめられる。aud は endpoint の origin、exp は 12 時間以内、sub は https の Worker の URL', async () => {
    const keys = await importVapidKeys(await generateVapidKeys());
    const now = 1_800_000_000_000;
    const h = await vapidAuthorization(keys, 'https://web.push.apple.com/QGuQyavXutnMH-a7?x=1', 'https://hangar.example.workers.dev', now);
    const v = await verifyVapid(h);
    expect(v.k).toBe(keys.publicKey);
    expect(v.header).toEqual({ typ: 'JWT', alg: 'ES256' });
    expect(v.claims.aud).toBe('https://web.push.apple.com');
    expect(v.claims.sub).toBe('https://hangar.example.workers.dev');
    const exp = v.claims.exp as number;
    expect(exp).toBeGreaterThan(now / 1000);
    expect(exp).toBeLessThanOrEqual(now / 1000 + 12 * 3600);
  });

  it('別の鍵の公開鍵では確かめられない', async () => {
    const a = await importVapidKeys(await generateVapidKeys());
    const b = await importVapidKeys(await generateVapidKeys());
    const h = await vapidAuthorization(a, 'https://fcm.googleapis.com/fcm/send/abc', 'https://w.example', Date.now());
    await expect(verifyVapid(h.replace(/k=.*$/, `k=${b.publicKey}`))).rejects.toThrow();
  });

  it('push の要求は aes128gcm と TTL 1 時間と Urgency normal を載せる', async () => {
    const keys = await importVapidKeys(await generateVapidKeys());
    const peer = await newPeer();
    const req = await pushRequest({ endpoint: 'https://fcm.googleapis.com/fcm/send/abc', p256dh: peer.p256dh, auth: peer.authText }, enc.encode('1.abc'), keys, 'https://w.example', Date.now());
    expect(req.method).toBe('POST');
    expect(req.url).toBe('https://fcm.googleapis.com/fcm/send/abc');
    expect(req.headers.get('content-encoding')).toBe('aes128gcm');
    expect(req.headers.get('content-type')).toBe('application/octet-stream');
    expect(req.headers.get('ttl')).toBe('3600');
    expect(req.headers.get('urgency')).toBe('normal');
    await verifyVapid(req.headers.get('authorization'));
    expect(new TextDecoder().decode(await openPush(new Uint8Array(await req.arrayBuffer()), peer))).toBe('1.abc');
  });
});

describe('endpoint のホストの制限', () => {
  it('既知の push サービスの https だけを通す', () => {
    for (const ok of [
      'https://web.push.apple.com/QGuQyavXutnMH-a7',
      'https://fcm.googleapis.com/fcm/send/abc:def',
      'https://updates.push.services.mozilla.com/wpush/v2/gAAA',
      'https://wns2-par02p.notify.windows.com/w/?token=abc',
    ]) expect(pushEndpointAllowed(ok), ok).toBe(true);
    for (const bad of [
      'http://fcm.googleapis.com/fcm/send/abc',
      'https://fcm.googleapis.com:8443/fcm/send/abc',
      'https://user:pw@fcm.googleapis.com/fcm/send/abc',
      'https://evil.example/fcm/send/abc',
      'https://fcm.googleapis.com.evil.example/x',
      'https://notify.windows.com.evil.example/x',
      'https://evilnotify.windows.com/x',
      'https://127.0.0.1/x',
      'https://localhost/x',
      'not a url',
      `https://fcm.googleapis.com/${'a'.repeat(2100)}`,
    ]) expect(pushEndpointAllowed(bad), bad).toBe(false);
  });
});

describe('夜の時間帯', () => {
  const at = (utcH: number, utcM: number) => Date.UTC(2026, 9, 18, utcH, utcM);
  const JST = -540;

  it('既定の 23:00〜7:00（日本の時刻）は鳴らさない', () => {
    expect(inQuietHours(at(14, 0), 1380, 420, JST)).toBe(true); // 23:00
    expect(inQuietHours(at(13, 59), 1380, 420, JST)).toBe(false); // 22:59
    expect(inQuietHours(at(17, 0), 1380, 420, JST)).toBe(true); // 2:00
    expect(inQuietHours(at(21, 59), 1380, 420, JST)).toBe(true); // 6:59
    expect(inQuietHours(at(22, 0), 1380, 420, JST)).toBe(false); // 7:00
    expect(inQuietHours(at(3, 0), 1380, 420, JST)).toBe(false); // 12:00
  });

  it('日をまたがない時間帯と、UTC より遅れた地域', () => {
    // 1:00〜5:00、ニューヨークの夏時間（UTC-4、getTimezoneOffset は 240）。
    expect(inQuietHours(at(6, 0), 60, 300, 240)).toBe(true); // 2:00
    expect(inQuietHours(at(9, 0), 60, 300, 240)).toBe(false); // 5:00
    expect(inQuietHours(at(4, 59), 60, 300, 240)).toBe(false); // 0:59
  });

  it('時間帯が無い（null）か、始まりと終わりが同じなら、いつでも鳴らす', () => {
    expect(inQuietHours(at(17, 0), null, null, JST)).toBe(false);
    expect(inQuietHours(at(17, 0), 600, 600, JST)).toBe(false);
  });
});
