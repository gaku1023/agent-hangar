import { X509Certificate, createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DEFAULT_FINGERPRINT_FILE, readFingerprintFile } from '../scripts/sign-macos.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const cerPath = path.resolve(here, '../signing/hangar-signing.cer');

// 置き場の公開の証明書と指紋が食い違うと、署名の DR が別の身元を指してしまう。
describe('署名の証明書の公開分', () => {
  it('指紋の置き場に、40 桁の 16 進の値が入っている', () => {
    const fp = readFingerprintFile(DEFAULT_FINGERPRINT_FILE);
    expect(fp).toBeDefined();
    expect(fp).toMatch(/^[0-9a-f]{40}$/);
  });

  it('hangar-signing.cer の SHA-1 が certificate-sha1.txt と一致する', () => {
    const der = fs.readFileSync(cerPath);
    const sha1 = createHash('sha1').update(der).digest('hex');
    expect(sha1).toBe(readFingerprintFile(DEFAULT_FINGERPRINT_FILE));
  });

  it('証明書は自己署名で、コード署名の用途を持ち、10 年以上の有効期間がある', () => {
    const cert = new X509Certificate(fs.readFileSync(cerPath));
    expect(cert.issuer).toBe(cert.subject);
    expect(cert.verify(cert.publicKey)).toBe(true);
    const years = (new Date(cert.validTo).getTime() - new Date(cert.validFrom).getTime()) / (365.25 * 24 * 3600 * 1000);
    expect(years).toBeGreaterThanOrEqual(10);
    expect(cert.keyUsage ?? []).toContain('1.3.6.1.5.5.7.3.3');
  });

  it('秘密鍵や p12 は置いていない', () => {
    const files = fs.readdirSync(path.dirname(cerPath));
    expect(files.filter((f) => /\.(p12|pfx|key|pem)$/i.test(f))).toEqual([]);
  });
});
