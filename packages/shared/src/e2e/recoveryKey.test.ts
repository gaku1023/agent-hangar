import { describe, expect, it } from 'vitest';
import { generateKeyPair } from './keys.ts';
import { RecoveryKeyError, formatRecoveryKey, parseRecoveryKey, recoverySecretTail } from './recoveryKey.ts';

const URL_ = 'https://hangar-example.workers.dev';

async function sample() {
  const { priv } = await generateKeyPair();
  return { priv, text: formatRecoveryKey({ priv, url: URL_, createdAt: Date.UTC(2026, 9, 17, 3) }) };
}

function secretLine(text: string): string {
  const line = text.split('\n').find((l) => l.startsWith('暗号鍵'));
  if (!line) throw new Error('暗号鍵の行が無い');
  return line;
}

function secretOf(text: string): string {
  return secretLine(text).replace(/^暗号鍵[:：]\s*/, '');
}

describe('リカバリーキー', () => {
  it('見出し、作成日、URL、暗号鍵の 4 行で、暗号鍵は 4 字ごとに区切った 64 字', async () => {
    const { text } = await sample();
    const lines = text.split('\n');
    expect(lines[0]).toBe('hangar リカバリーキー');
    expect(lines.some((l) => l.startsWith('作成日'))).toBe(true);
    expect(lines.some((l) => l.includes(URL_))).toBe(true);
    const secret = secretOf(text);
    expect(secret).toMatch(/^([A-Z2-7]{4}-){12}[A-Z2-7]{4}$/);
    expect(secret.length).toBe(64);
  });

  it('format→parse で秘密鍵と URL が戻る', async () => {
    const { priv, text } = await sample();
    expect(parseRecoveryKey(text)).toEqual({ priv, url: URL_ });
  });

  it('見出しと行の順の揺れ、前後の空白、CRLF、小文字を許す', async () => {
    const { priv, text } = await sample();
    const lines = text.split('\n');
    const shuffled = ['', '  ' + lines[3], (lines[2] ?? '') + '  ', lines[1], '  ' + lines[0], ''].join('\r\n');
    expect(parseRecoveryKey(shuffled)).toEqual({ priv, url: URL_ });
    const line = secretLine(text);
    expect(parseRecoveryKey(text.replace(line, '暗号鍵: ' + secretOf(text).toLowerCase()))).toEqual({ priv, url: URL_ });
  });

  it('区切りの - が抜けていても読める', async () => {
    const { priv, text } = await sample();
    const line = secretLine(text);
    expect(parseRecoveryKey(text.replace(line, line.replace(/-/g, '')))).toEqual({ priv, url: URL_ });
    expect(parseRecoveryKey(text.replace(line, '暗号鍵: ' + secretOf(text).replace(/-/g, ' ')))).toEqual({ priv, url: URL_ });
  });

  it('1 字違えば RecoveryKeyError（base32 の字種の外）', async () => {
    const { text } = await sample();
    const line = secretLine(text);
    expect(() => parseRecoveryKey(text.replace(line, line.slice(0, -1) + '1'))).toThrow(RecoveryKeyError);
    expect(() => parseRecoveryKey(text.replace(line, line.slice(0, -1) + '0'))).toThrow(RecoveryKeyError);
    expect(() => parseRecoveryKey(text.replace(line, line.slice(0, 10) + '8' + line.slice(11)))).toThrow(RecoveryKeyError);
  });

  it('字が足りない、URL が無い、暗号鍵が無いときも RecoveryKeyError', async () => {
    const { text } = await sample();
    const line = secretLine(text);
    expect(() => parseRecoveryKey(text.replace(line, line.slice(0, -4)))).toThrow(RecoveryKeyError);
    expect(() => parseRecoveryKey(text.split('\n').filter((l) => !l.startsWith('URL')).join('\n'))).toThrow(RecoveryKeyError);
    expect(() => parseRecoveryKey(text.replace(line, ''))).toThrow(RecoveryKeyError);
    expect(() => parseRecoveryKey('')).toThrow(RecoveryKeyError);
  });

  it('recoverySecretTail は末尾 4 文字', async () => {
    const { text } = await sample();
    expect(recoverySecretTail(text)).toBe(secretOf(text).slice(-4));
    expect(recoverySecretTail(text)).toMatch(/^[A-Z2-7]{4}$/);
  });
});
