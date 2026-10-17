/**
 * node:crypto と WebCrypto の相互運用の試験。
 *
 * 本物の e2e の部品は WebCrypto だけを使う（PC もスマホも同じ実装を読む）。
 * ここでは node:crypto だけで書いた参照の実装を置き、双方向に読めることを確かめる。
 * shared で node:crypto を import してよいのは、この種の試験ファイルだけである。
 */

import { createCipheriv, createDecipheriv, createHmac, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, pbkdf2Sync, randomBytes } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { fromBase64Url, fromBase64UrlLen, toBase64Url, utf8 } from './bytes.ts';
import { deriveJoinSecrets, deriveSas, openJoinRequest, sealJoinRequest } from './joinCode.ts';
import { PURPOSE_INFO, deriveEpochKeys, deriveSubkeyBytes, ecdhBits, generateKeyPair, importPrivate, randomEpochKey, type Purpose } from './keys.ts';
import { openKeybox, sealKeybox } from './keybox.ts';
import { rowK } from './names.ts';
import { openRow, rowAadString, sealRow, type RowAad } from './seal.ts';

// RFC 8410 の前置き。参照の実装は keys.ts の定数を使わず、ここで独立に持つ。
const PKCS8_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex');
const SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');

const raw32 = (s: string): Buffer => Buffer.from(fromBase64UrlLen(s, 32, 'key'));
const nodePriv = (priv: string) => createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, raw32(priv)]), format: 'der', type: 'pkcs8' });
const nodePub = (pub: string) => createPublicKey({ key: Buffer.concat([SPKI_PREFIX, raw32(pub)]), format: 'der', type: 'spki' });
const nodeEcdh = (priv: string, pub: string): Buffer => diffieHellman({ privateKey: nodePriv(priv), publicKey: nodePub(pub) });

const PURPOSES: Purpose[] = ['row', 'index', 'fp', 'file', 'roster'];
const hkdfOf = (epochKey: string, purpose: string): Buffer => Buffer.from(hkdfSync('sha256', raw32(epochKey), Buffer.alloc(0), `hangar-e2e-v2/${purpose}`, 32));

type BoxAad = { epoch: number; recipient: string };
const boxAad = (a: BoxAad): Buffer => Buffer.from(JSON.stringify(['keybox', a.epoch, a.recipient]), 'utf8');

// node:crypto だけで書いた keybox の参照の実装（封じる側）。
function refSealKeybox(recipientPub: string, aad: BoxAad, content: Uint8Array): Buffer {
  const recipient = raw32(recipientPub);
  const eph = generateKeyPairSync('x25519');
  const ephPub = Buffer.from(eph.publicKey.export({ format: 'der', type: 'spki' })).subarray(SPKI_PREFIX.length);
  const shared = diffieHellman({ privateKey: eph.privateKey, publicKey: nodePub(recipientPub) });
  const key = Buffer.from(hkdfSync('sha256', shared, Buffer.concat([ephPub, recipient]), 'hangar-keybox-v1', 32));
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(boxAad(aad));
  const ct = Buffer.concat([c.update(content), c.final()]);
  return Buffer.concat([ephPub, iv, ct, c.getAuthTag()]);
}

// 同じく開く側。
function refOpenKeybox(myPriv: string, myPub: string, aad: BoxAad, sealed: Uint8Array): Buffer {
  const b = Buffer.from(sealed);
  const ephPub = b.subarray(0, 32);
  const iv = b.subarray(32, 44);
  const body = b.subarray(44, b.length - 16);
  const tag = b.subarray(b.length - 16);
  const shared = nodeEcdh(myPriv, toBase64Url(ephPub));
  const key = Buffer.from(hkdfSync('sha256', shared, Buffer.concat([ephPub, raw32(myPub)]), 'hangar-keybox-v1', 32));
  const d = createDecipheriv('aes-256-gcm', key, iv);
  d.setAAD(boxAad(aad));
  d.setAuthTag(tag);
  return Buffer.concat([d.update(body), d.final()]);
}

describe('interop: X25519', () => {
  it('WebCrypto の鍵ペアの raw を node:crypto に入れると、同じ共有の秘密になる', async () => {
    const a = await generateKeyPair();
    const b = await generateKeyPair();
    const viaWeb = await ecdhBits(await importPrivate(a.priv), b.pub);
    const viaNode = nodeEcdh(a.priv, b.pub);
    expect(Buffer.from(viaWeb).equals(viaNode)).toBe(true);
    // 逆向きでも同じになる。
    expect(nodeEcdh(b.priv, a.pub).equals(viaNode)).toBe(true);
  });

  it('node:crypto の鍵ペアの raw を WebCrypto に入れても、同じ共有の秘密になる', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('x25519');
    const priv = toBase64Url(Buffer.from(privateKey.export({ format: 'der', type: 'pkcs8' })).subarray(PKCS8_PREFIX.length));
    const pub = toBase64Url(Buffer.from(publicKey.export({ format: 'der', type: 'spki' })).subarray(SPKI_PREFIX.length));
    const other = await generateKeyPair();
    const viaWeb = await ecdhBits(await importPrivate(priv), other.pub);
    expect(Buffer.from(viaWeb).equals(nodeEcdh(priv, other.pub))).toBe(true);
    expect(Buffer.from(await ecdhBits(await importPrivate(other.priv), pub)).equals(Buffer.from(viaWeb))).toBe(true);
  });
});

describe('interop: HKDF と HMAC', () => {
  it('node:crypto の hkdfSync で導いた用途の鍵と deriveSubkeyBytes が一致する（5 つの用途）', async () => {
    const epochKey = randomEpochKey();
    for (const p of PURPOSES) {
      expect(PURPOSE_INFO[p]).toBe(`hangar-e2e-v2/${p}`);
      expect(Buffer.from(await deriveSubkeyBytes(epochKey, p)).equals(hkdfOf(epochKey, p))).toBe(true);
    }
  });

  it('deriveEpochKeys の fileBytes は file の用途の鍵そのもの', async () => {
    const epochKey = randomEpochKey();
    const keys = await deriveEpochKeys(3, epochKey);
    expect(Buffer.from(keys.fileBytes).equals(hkdfOf(epochKey, 'file'))).toBe(true);
  });

  it('node:crypto の createHmac で計算した rowK と names.ts が一致する', async () => {
    const epochKey = randomEpochKey();
    const keys = await deriveEpochKeys(1, epochKey);
    const indexBytes = hkdfOf(epochKey, 'index');
    for (const [table, rowId] of [['sessions', 'abc-123'], ['todos', '日本語の ID'], ['x', '']] as const) {
      const expected = toBase64Url(createHmac('sha256', indexBytes).update(`${table}:${rowId}`, 'utf8').digest());
      expect(await rowK(keys.index, table, rowId)).toBe(expected);
    }
  });
});

describe('interop: 行の封じ', () => {
  const aad: RowAad = { k: 'some-k', deviceId: 'pc-a', updatedAt: 1760000000000, op: 'upsert', epoch: 2 };
  const rowAad = Buffer.from(JSON.stringify(['row', aad.k, aad.deviceId, aad.updatedAt, aad.op, aad.epoch]), 'utf8');

  // 参照の実装で開く。版が 0x02、iv が 1〜12 バイト目、tag が末尾 16 バイト。
  function refOpenRow(rowKeyBytes: Buffer, sealed: Uint8Array): { flag: number; body: Buffer } {
    const b = Buffer.from(sealed);
    expect(b[0]).toBe(0x02);
    const d = createDecipheriv('aes-256-gcm', rowKeyBytes, b.subarray(1, 13));
    d.setAAD(rowAad);
    d.setAuthTag(b.subarray(b.length - 16));
    const plain = Buffer.concat([d.update(b.subarray(13, b.length - 16)), d.final()]);
    return { flag: plain[0]!, body: plain.subarray(1) };
  }

  it('sealRow の出力を node:crypto の AES-256-GCM で開ける', async () => {
    const epochKey = randomEpochKey();
    const keys = await deriveEpochKeys(aad.epoch, epochKey);
    const body = { tableName: 'sessions', rowId: 'r1', payload: { title: '短い' } };
    const sealed = await sealRow(keys.row, aad, body);
    const { flag, body: json } = refOpenRow(hkdfOf(epochKey, 'row'), sealed);
    expect(flag).toBe(0x00);
    expect(JSON.parse(json.toString('utf8'))).toEqual(body);
    // 宛先の文字列も、独立に組んだものと同じ。
    expect(rowAadString(aad)).toBe(rowAad.toString('utf8'));
  });

  it('256 バイト以上は gzip の印（0x01）で封じられ、zlib で戻せる', async () => {
    const epochKey = randomEpochKey();
    const keys = await deriveEpochKeys(aad.epoch, epochKey);
    const body = { tableName: 'sessions', rowId: 'r2', payload: { text: 'あ'.repeat(500) } };
    const sealed = await sealRow(keys.row, aad, body);
    const { flag, body: gz } = refOpenRow(hkdfOf(epochKey, 'row'), sealed);
    expect(flag).toBe(0x01);
    expect(JSON.parse(gunzipSync(gz).toString('utf8'))).toEqual(body);
  });

  it('node:crypto で封じた行を openRow で開ける', async () => {
    const epochKey = randomEpochKey();
    const keys = await deriveEpochKeys(aad.epoch, epochKey);
    const body = { tableName: 'todos', rowId: 'r3', payload: { n: 1 } };
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', hkdfOf(epochKey, 'row'), iv);
    c.setAAD(rowAad);
    const plain = Buffer.concat([Buffer.from([0x00]), Buffer.from(JSON.stringify(body), 'utf8')]);
    const ct = Buffer.concat([c.update(plain), c.final()]);
    const sealed = Buffer.concat([Buffer.from([0x02]), iv, ct, c.getAuthTag()]);
    expect(await openRow(keys.row, aad, sealed)).toEqual(body);
  });
});

describe('interop: keybox', () => {
  const aad = { epoch: 4, recipient: 'pc-b' };
  const content = utf8.encode('世代鍵の一覧');

  it('keybox を node:crypto だけで書いた参照の実装で開ける', async () => {
    const b = await generateKeyPair();
    const sealed = await sealKeybox(b.pub, aad, content);
    expect(refOpenKeybox(b.priv, b.pub, aad, sealed).equals(Buffer.from(content))).toBe(true);
  });

  it('参照の実装で封じた keybox を openKeybox で開ける', async () => {
    const b = await generateKeyPair();
    const sealed = refSealKeybox(b.pub, aad, content);
    const opened = await openKeybox(await importPrivate(b.priv), b.pub, aad, sealed);
    expect(Buffer.from(opened).equals(Buffer.from(content))).toBe(true);
  });

  it('参照の実装も宛先が違えば開けない（AAD を実際に縛っている）', async () => {
    const b = await generateKeyPair();
    const sealed = await sealKeybox(b.pub, aad, content);
    expect(() => refOpenKeybox(b.priv, b.pub, { epoch: 5, recipient: 'pc-b' }, sealed)).toThrow();
    expect(() => refOpenKeybox(b.priv, b.pub, { epoch: 4, recipient: 'pc-c' }, sealed)).toThrow();
  });
});

describe('interop: 参加コード（本番の回数）', () => {
  const code = 'K7QM-2XFD';
  const cloudId = 'cloud-a-0123456789';
  // 参照の実装。PBKDF2-SHA256 の 300 万回で 32 バイトの種を作り、用途ごとに HKDF で分ける。
  const seed = pbkdf2Sync(Buffer.from('K7QM2XFD', 'utf8'), Buffer.from(`hangar-join-v1:${cloudId}`, 'utf8'), 3_000_000, 32, 'sha256');
  const refSub = (salt: Buffer, info: string, len: number): Buffer => Buffer.from(hkdfSync('sha256', seed, salt, info, len));

  it('本番の回数で導いた codeHash が node:crypto の参照の実装と一致する', async () => {
    const s = await deriveJoinSecrets(code, cloudId);
    expect(s.codeHash).toBe(refSub(Buffer.alloc(0), 'hangar-join-hash-v1', 32).toString('hex'));
  });

  it('確認コードが参照の実装と一致する', async () => {
    const b = await generateKeyPair();
    const n = refSub(raw32(b.pub), 'hangar-join-sas-v1', 4).readUInt32BE(0);
    expect(await deriveSas(await deriveJoinSecrets(code, cloudId), b.pub)).toBe(String(n % 1_000_000).padStart(6, '0'));
  });

  it('参加リクエストを参照の実装で開け、参照の実装で封じたものを openJoinRequest で開ける', async () => {
    const s = await deriveJoinSecrets(code, cloudId);
    const key = refSub(Buffer.alloc(0), 'hangar-join-req-v1', 32);
    const aad = Buffer.from(`join:${s.codeHash}`, 'utf8');
    const body = { pub: (await generateKeyPair()).pub, name: 'pc-b', os: 'linux' };

    const sealed = Buffer.from(fromBase64Url(await sealJoinRequest(s, body))!);
    const d = createDecipheriv('aes-256-gcm', key, sealed.subarray(0, 12));
    d.setAAD(aad);
    d.setAuthTag(sealed.subarray(sealed.length - 16));
    expect(JSON.parse(Buffer.concat([d.update(sealed.subarray(12, sealed.length - 16)), d.final()]).toString('utf8'))).toEqual(body);

    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', key, iv);
    c.setAAD(aad);
    const ct = Buffer.concat([c.update(Buffer.from(JSON.stringify(body), 'utf8')), c.final(), c.getAuthTag()]);
    expect(await openJoinRequest(s, toBase64Url(Buffer.concat([iv, ct])))).toEqual(body);
  });
});
