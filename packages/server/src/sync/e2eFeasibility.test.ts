// CI の Windows で暗号の部品を確かめるための使い捨ての試験。マージしない。
// node:crypto と WebCrypto（globalThis.crypto.subtle）の両方で、鍵合意、署名、鍵導出、封じ込み、HMAC を通す。
import * as nc from 'node:crypto';
import { describe, expect, it } from 'vitest';

const subtle = globalThis.crypto.subtle;

describe('X25519', () => {
  it('node:crypto の 2 組で共有秘密が一致する', () => {
    const a = nc.generateKeyPairSync('x25519');
    const b = nc.generateKeyPairSync('x25519');
    const s1 = nc.diffieHellman({ privateKey: a.privateKey, publicKey: b.publicKey });
    const s2 = nc.diffieHellman({ privateKey: b.privateKey, publicKey: a.publicKey });
    expect(s1.length).toBe(32);
    expect(s1.equals(s2)).toBe(true);
  });

  it('WebCrypto の 2 組で共有秘密が一致する', async () => {
    const a = await subtle.generateKey('X25519', true, ['deriveBits']);
    const b = await subtle.generateKey('X25519', true, ['deriveBits']);
    const s1 = Buffer.from(await subtle.deriveBits({ name: 'X25519', public: b.publicKey }, a.privateKey, 256));
    const s2 = Buffer.from(await subtle.deriveBits({ name: 'X25519', public: a.publicKey }, b.privateKey, 256));
    expect(s1.equals(s2)).toBe(true);
  });

  it('WebCrypto の raw 公開鍵を node:crypto に渡しても一致する', async () => {
    const a = await subtle.generateKey('X25519', true, ['deriveBits']);
    const raw = Buffer.from(await subtle.exportKey('raw', a.publicKey));
    expect(raw.length).toBe(32);
    const b = nc.generateKeyPairSync('x25519');
    const pubA = nc.createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x: raw.toString('base64url') }, format: 'jwk' });
    const s1 = nc.diffieHellman({ privateKey: b.privateKey, publicKey: pubA });
    const pubB = await subtle.importKey('jwk', b.publicKey.export({ format: 'jwk' }), 'X25519', true, []);
    const s2 = Buffer.from(await subtle.deriveBits({ name: 'X25519', public: pubB }, a.privateKey, 256));
    expect(s1.equals(s2)).toBe(true);
  });
});

describe('Ed25519', () => {
  it('node:crypto で署名と検証ができ、改竄で落ちる', () => {
    const k = nc.generateKeyPairSync('ed25519');
    const msg = Buffer.from('hello');
    const sig = nc.sign(null, msg, k.privateKey);
    expect(nc.verify(null, msg, k.publicKey, sig)).toBe(true);
    expect(nc.verify(null, Buffer.from('hellp'), k.publicKey, sig)).toBe(false);
  });

  it('WebCrypto で署名と検証ができ、改竄で落ちる', async () => {
    const k = await subtle.generateKey('Ed25519', true, ['sign', 'verify']);
    const msg = Buffer.from('hello');
    const sig = await subtle.sign('Ed25519', k.privateKey, msg);
    expect(await subtle.verify('Ed25519', k.publicKey, sig, msg)).toBe(true);
    expect(await subtle.verify('Ed25519', k.publicKey, sig, Buffer.from('hellp'))).toBe(false);
  });

  it('node:crypto の署名を WebCrypto で検証できる', async () => {
    const k = nc.generateKeyPairSync('ed25519');
    const msg = Buffer.from('hello');
    const sig = nc.sign(null, msg, k.privateKey);
    const pub = await subtle.importKey('jwk', k.publicKey.export({ format: 'jwk' }), 'Ed25519', false, ['verify']);
    expect(await subtle.verify('Ed25519', pub, sig, msg)).toBe(true);
  });
});

describe('HKDF と AES-256-GCM', () => {
  it('node:crypto で 32 バイトを導き、AAD 付きで封じて開ける', () => {
    const key = Buffer.from(nc.hkdfSync('sha256', 'secret', 'salt', 'info', 32));
    expect(key.length).toBe(32);
    const iv = nc.randomBytes(12);
    const aad = Buffer.from('aad');
    const c = nc.createCipheriv('aes-256-gcm', key, iv);
    c.setAAD(aad);
    const ct = Buffer.concat([c.update('hi'), c.final()]);
    const tag = c.getAuthTag();
    const open = (a: Buffer) => {
      const d = nc.createDecipheriv('aes-256-gcm', key, iv);
      d.setAAD(a);
      d.setAuthTag(tag);
      return Buffer.concat([d.update(ct), d.final()]).toString();
    };
    expect(open(aad)).toBe('hi');
    expect(() => open(Buffer.from('other'))).toThrow();
  });

  it('WebCrypto で 32 バイトを導き、AAD 付きで封じて開ける', async () => {
    const base = await subtle.importKey('raw', Buffer.from('secret'), 'HKDF', false, ['deriveKey', 'deriveBits']);
    const params = { name: 'HKDF', hash: 'SHA-256', salt: Buffer.from('salt'), info: Buffer.from('info') };
    expect((await subtle.deriveBits(params, base, 256)).byteLength).toBe(32);
    const key = await subtle.deriveKey(params, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    const iv = nc.randomBytes(12);
    const ct = await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: Buffer.from('aad') }, key, Buffer.from('hi'));
    const pt = await subtle.decrypt({ name: 'AES-GCM', iv, additionalData: Buffer.from('aad') }, key, ct);
    expect(Buffer.from(pt).toString()).toBe('hi');
    await expect(subtle.decrypt({ name: 'AES-GCM', iv, additionalData: Buffer.from('other') }, key, ct)).rejects.toThrow();
  });
});

describe('HMAC-SHA256', () => {
  it('node:crypto と WebCrypto で同じ値になる', async () => {
    const mac = nc.createHmac('sha256', 'k').update('m').digest();
    expect(mac.length).toBe(32);
    const key = await subtle.importKey('raw', Buffer.from('k'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const wc = Buffer.from(await subtle.sign('HMAC', key, Buffer.from('m')));
    expect(wc.equals(mac)).toBe(true);
  });
});
