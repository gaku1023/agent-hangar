import { describe, expect, it } from 'vitest';
import { deriveEpochKeys, randomEpochKey } from './keys.ts';
import { configBlobKey, fingerprint, isBlobKey, opencodeBlobKey, rowK, transcriptBlobKey } from './names.ts';

async function keys() {
  return deriveEpochKeys(1, randomEpochKey());
}

const UUID = '0b6d2a3e-6f4c-4b8e-9f1a-2c3d4e5f6a7b';

describe('鍵名（HMAC）', () => {
  it('rowK は同じ表と行で同じ、表が違えば別', async () => {
    const { index } = await keys();
    const a = await rowK(index, 'sessions', 'row-1');
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await rowK(index, 'sessions', 'row-1')).toBe(a);
    expect(await rowK(index, 'notes', 'row-1')).not.toBe(a);
    expect(await rowK(index, 'sessions', 'row-2')).not.toBe(a);
  });

  it('transcriptBlobKey はサブエージェントの有無で別', async () => {
    const { index } = await keys();
    const main = await transcriptBlobKey(index, 'pc-a', 'pc-a', UUID, null);
    const sub = await transcriptBlobKey(index, 'pc-a', 'pc-a', UUID, 'agent-1');
    expect(main).not.toBe(sub);
    expect(main.startsWith('b/pc-a/')).toBe(true);
    expect(isBlobKey(main)).toBe(true);
    expect(isBlobKey(sub)).toBe(true);
    expect(await transcriptBlobKey(index, 'pc-a', 'pc-b', UUID, null)).not.toBe(main);
  });

  it('Claude の本文の鍵名は、opencode を足す前と 1 字も変わらない', async () => {
    // 固定の世代鍵で求めた値を書き写してある。HMAC の入力を変えると、上げ済みの本文がほかの PC から見つからなくなる。
    const { index } = await deriveEpochKeys(1, 'A'.repeat(43));
    expect(await transcriptBlobKey(index, 'pc-a', 'pc-a', UUID, null)).toBe('b/pc-a/NkHKDU8Nbc60bTFsADMrZcURVfGXZXTHofDvz5R0RZM');
    expect(await transcriptBlobKey(index, 'pc-a', 'pc-b', UUID, 'a1b2c3')).toBe('b/pc-a/PwSmqymm9mECQSKKGoX1FFBhk239OGDOlskLIwuy6nk');
  });

  it('opencodeBlobKey は Claude の鍵名と交わらない', async () => {
    const { index } = await keys();
    const ses = 'ses_f55764078ffeDvMj180Fvan87g';
    const oc = await opencodeBlobKey(index, 'pc-a', 'pc-a', ses);
    expect(isBlobKey(oc)).toBe(true);
    expect(oc.startsWith('b/pc-a/')).toBe(true);
    expect(oc.includes(ses)).toBe(false);
    expect(await opencodeBlobKey(index, 'pc-a', 'pc-a', ses)).toBe(oc);
    expect(oc).not.toBe(await transcriptBlobKey(index, 'pc-a', 'pc-a', ses, null));
    // 元の PC の ID が「opencode」でも、Claude のサブエージェントの鍵名と同じ入力にならない。
    expect(await opencodeBlobKey(index, 'pc-a', 'x', ses)).not.toBe(await transcriptBlobKey(index, 'pc-a', 'opencode', 'x', ses));
    expect(await opencodeBlobKey(index, 'pc-a', 'pc-b', ses)).not.toBe(oc);
    await expect(opencodeBlobKey(index, '../x', 'pc-a', ses)).rejects.toThrow();
  });

  it('configBlobKey は相対パスごとに別で、同じ入力なら同じ', async () => {
    const { index } = await keys();
    const a = await configBlobKey(index, 'pc-a', 'pc-a', 'settings.json');
    const b = await configBlobKey(index, 'pc-a', 'pc-a', 'CLAUDE.md');
    expect(a).not.toBe(b);
    expect(isBlobKey(a)).toBe(true);
    expect(await configBlobKey(index, 'pc-a', 'pc-a', 'settings.json')).toBe(a);
  });

  it('鍵名にセッションの UUID とパスが含まれない', async () => {
    const { index } = await keys();
    const t = await transcriptBlobKey(index, 'pc-a', 'pc-a', UUID, 'agent-1');
    const c = await configBlobKey(index, 'pc-a', 'pc-a', 'skills/example/SKILL.md');
    for (const s of [UUID, UUID.slice(0, 8), 'agent-1']) expect(t.includes(s)).toBe(false);
    for (const s of ['skills', 'SKILL', 'example']) expect(c.includes(s)).toBe(false);
  });

  it('isBlobKey が鍵名を通し、../ や空を断る', () => {
    expect(isBlobKey(`b/pc-a/${'A'.repeat(43)}`)).toBe(true);
    expect(isBlobKey('')).toBe(false);
    expect(isBlobKey('b//' + 'A'.repeat(43))).toBe(false);
    expect(isBlobKey(`b/../${'A'.repeat(43)}`)).toBe(false);
    expect(isBlobKey(`b/pc-a/../${'A'.repeat(40)}`)).toBe(false);
    expect(isBlobKey(`b/pc-a/${'A'.repeat(42)}`)).toBe(false);
    expect(isBlobKey(`b/pc-a/${'A'.repeat(44)}`)).toBe(false);
    expect(isBlobKey(`config/pc-a/${'A'.repeat(43)}`)).toBe(false);
    expect(isBlobKey(`b/${'a'.repeat(65)}/${'A'.repeat(43)}`)).toBe(false);
  });

  it('形の違う deviceId では鍵名を作らない', async () => {
    const { index } = await keys();
    await expect(transcriptBlobKey(index, '../x', 'pc-a', UUID, null)).rejects.toThrow();
    await expect(configBlobKey(index, '', 'pc-a', 'a')).rejects.toThrow();
  });

  it('世代が違えば別の鍵名', async () => {
    const a = await keys();
    const b = await keys();
    expect(await rowK(a.index, 'sessions', 'row-1')).not.toBe(await rowK(b.index, 'sessions', 'row-1'));
    expect(await transcriptBlobKey(a.index, 'pc-a', 'pc-a', UUID, null)).not.toBe(await transcriptBlobKey(b.index, 'pc-a', 'pc-a', UUID, null));
  });

  it('fingerprint は同じ SHA-256 で同じ、違えば別、大小文字を区別しない', async () => {
    const { fp, index } = await keys();
    const h = 'ab'.repeat(32);
    const f = await fingerprint(fp, h);
    expect(f).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await fingerprint(fp, h.toUpperCase())).toBe(f);
    expect(await fingerprint(fp, 'cd'.repeat(32))).not.toBe(f);
    expect(f.includes(h)).toBe(false);
    // 用途の鍵が違えば別。
    expect(await fingerprint(index, h)).not.toBe(f);
  });
});
