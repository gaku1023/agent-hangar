import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

const base = fs.readFileSync(new URL('./base.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
/**
 * 入れ子の無い規則を、選択子と中身の組で取り出す。
 * コンテナクエリの中の規則も、内側の規則として拾える。
 */
const rules = [...base.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ selector: m[1]!.trim(), body: m[2]! }));

describe('ヘッダーの使用率のゲージ', () => {
  it('見出し（5 時間、週）はどの幅でも隠さない', () => {
    const keys = rules.filter((r) => r.selector.split(',').some((s) => s.trim() === '.header .gauge-key'));
    expect(keys.length).toBeGreaterThan(0);
    for (const r of keys) expect(r.body).not.toMatch(/display:\s*none/);
  });
  it('狭い幅では棒だけを畳み、見出しと数字は残す', () => {
    const narrow = rules.find((r) => r.selector === '.header .gauge-bar');
    expect(narrow?.body).toMatch(/display:\s*none/);
  });
});
