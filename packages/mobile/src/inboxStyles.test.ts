import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 受信箱の長い文字列（PC の名前、アカウントの名前、題）で、行が横にはみ出さないこと。
 * iPhone で、実行中の行の PC 名が長いと画面全体が横にずれ、左が欠けた（2026-10-21）。
 */
describe('受信箱の横のはみ出し', () => {
  const css = fs.readFileSync(path.join(import.meta.dirname, 'styles.css'), 'utf8');
  const rule = (sel: string): string => new RegExp(`(?:^|\\n)${sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{[^}]*\\}`).exec(css)?.[0] ?? '';
  const cut = (sel: string): void => {
    const r = rule(sel);
    expect(r, sel).toContain('min-width: 0');
    expect(r, sel).toContain('overflow: hidden');
    expect(r, sel).toContain('text-overflow: ellipsis');
    expect(r, sel).toContain('white-space: nowrap');
    expect(r, sel).toMatch(/max-width: /);
    expect(r, sel).not.toContain('flex: none');
  };

  it('受信箱は横にスクロールしない', () => {
    expect(rule('.inbox-scroll')).toMatch(/overflow-x: (hidden|clip)/);
  });

  it('行の右端（PC の名前と経過）は縮み、末尾を … で切る', () => {
    cut('.thin-meta');
  });

  it('生存の行の PC の名前は … で切り、1 つの PC が行の幅を超えない', () => {
    cut('.alive-name');
    expect(rule('.alive')).toContain('max-width: 100%');
    expect(rule('.alive')).toContain('min-width: 0');
  });

  it('入力待ちの札の「〜のアカウントで開く」も縮んで … で切る', () => {
    cut('.wait-open');
  });
});
