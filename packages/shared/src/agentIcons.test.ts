import { describe, expect, it } from 'vitest';
import { AGENT_ICON_FRAME, AGENT_ICON_KINDS, AGENT_ICONS, AGENT_LABEL, agentIconKindOf, agentIconsShown, agentIconSvg, CLAWD_ROWS } from './agentIcons.ts';

/** Claude Code の起動の見出しの文字絵（Clawd）。1 文字を 2×2 の升に読む。 */
const CLAWD_GLYPHS = [' ▐▛███▜▌', '▝▜█████▛▘', '  ▘▘ ▝▝'];
const QUAD: Record<string, [number, number, number, number]> = {
  ' ': [0, 0, 0, 0], '█': [1, 1, 1, 1], '▐': [0, 1, 0, 1], '▌': [1, 0, 1, 0],
  '▛': [1, 1, 1, 0], '▜': [1, 1, 0, 1], '▝': [0, 1, 0, 0], '▘': [1, 0, 0, 0],
};
function decode(lines: string[], width: number): string[] {
  const rows: string[] = [];
  for (const line of lines) {
    const top: string[] = [];
    const bottom: string[] = [];
    for (const ch of [...line.padEnd(width / 2, ' ')]) {
      const [ul, ur, ll, lr] = QUAD[ch]!;
      top.push(ul ? '#' : '.', ur ? '#' : '.');
      bottom.push(ll ? '#' : '.', lr ? '#' : '.');
    }
    rows.push(top.join(''), bottom.join(''));
  }
  return rows;
}

describe('エージェントの絵の組', () => {
  it('絵を持つのは Claude Code と opencode だけで、Codex の絵は置かない', () => {
    expect([...AGENT_ICON_KINDS]).toEqual(['claude-code', 'opencode']);
    expect(Object.keys(AGENT_ICONS).sort()).toEqual(['claude-code', 'opencode']);
    for (const kind of AGENT_ICON_KINDS) {
      for (const tone of ['light', 'dark'] as const) expect(agentIconSvg(kind, tone).toLowerCase()).not.toMatch(/codex|openai/);
    }
  });

  it('どの絵にも、明るい地用と暗い地用があり、枠（約 20px）に収まる', () => {
    expect(AGENT_ICON_FRAME.width).toBe(20);
    for (const kind of AGENT_ICON_KINDS) {
      for (const tone of ['light', 'dark'] as const) {
        const art = AGENT_ICONS[kind][tone];
        expect(art.paths.length).toBeGreaterThan(0);
        expect(art.width).toBeLessThanOrEqual(AGENT_ICON_FRAME.width);
        expect(art.height).toBeLessThanOrEqual(AGENT_ICON_FRAME.height);
      }
    }
  });

  it('Clawd は文字絵 ▐▛███▜▌ / ▝▜█████▛▘ / ▘▘ ▝▝ を升に起こし、縦を 2 倍にして描く', () => {
    expect(CLAWD_ROWS).toEqual(decode(CLAWD_GLYPHS, 18));
    const art = AGENT_ICONS['claude-code'].light;
    expect(art.viewBox).toBe('0 0 18 6');
    expect(art).toMatchObject({ width: 18, height: 12, stretch: true, crisp: true });
    expect(art.paths).toEqual([{ d: expect.stringMatching(/^M3 0h1v1h-1z/), fill: '#d97757' }]);
    // 升の数と同じだけ 1×1 の四角がある。
    const cells = CLAWD_ROWS.join('').split('').filter((c) => c === '#').length;
    expect(art.paths[0]!.d.match(/h1v1h-1z/g)).toHaveLength(cells);
  });

  it('opencode は公式の SVG（opencode.ai/brand）の形と色をそのまま使う', () => {
    const light = AGENT_ICONS.opencode.light;
    const dark = AGENT_ICONS.opencode.dark;
    expect(light.viewBox).toBe('0 0 240 300');
    expect(light.paths).toEqual([
      { d: 'M180 240H60V120H180V240Z', fill: '#CFCECD' },
      { d: 'M180 60H60V240H180V60ZM240 300H0V0H240V300Z', fill: '#211E1E' },
    ]);
    expect(dark.paths).toEqual([
      { d: 'M180 240H60V120H180V240Z', fill: '#4B4646' },
      { d: 'M180 60H60V240H180V60ZM240 300H0V0H240V300Z', fill: '#F1ECEC' },
    ]);
    // 縦横比を崩さない。
    expect(light.width / light.height).toBeCloseTo(240 / 300, 5);
    expect(light.stretch).toBe(false);
  });

  it('名前はエージェントの名前のまま出す', () => {
    expect(AGENT_LABEL).toEqual({ 'claude-code': 'Claude Code', opencode: 'opencode' });
  });

  it('SVG の文字列は、スマホのように文字列で差し込む場所に使える', () => {
    const svg = agentIconSvg('opencode', 'dark');
    expect(svg).toMatch(/^<svg [^>]*viewBox="0 0 240 300"/);
    expect(svg).toContain('fill="#F1ECEC"');
    expect(agentIconSvg('claude-code', 'light')).toContain('preserveAspectRatio="none"');
  });
});

describe('行のエージェントの読み方', () => {
  it('種類の無い行（古いサーバ、Claude の行）は Clawd、opencode は opencode、知らない種類は絵を出さない', () => {
    expect(agentIconKindOf(undefined)).toBe('claude-code');
    expect(agentIconKindOf(null)).toBe('claude-code');
    expect(agentIconKindOf('claude-code')).toBe('claude-code');
    expect(agentIconKindOf('opencode')).toBe('opencode');
    expect(agentIconKindOf('codex')).toBeNull();
  });
});

describe('アイコンを出すか', () => {
  it('opencode が切で、opencode の会話が 1 つも無いときは出さない（切のままなら見た目は変わらない）', () => {
    expect(agentIconsShown({ opencodeEnabled: false, hasOpencode: false })).toBe(false);
  });
  it('opencode を有効にしたか、opencode の会話が 1 つでもあれば、全部の行に出す', () => {
    expect(agentIconsShown({ opencodeEnabled: true, hasOpencode: false })).toBe(true);
    expect(agentIconsShown({ opencodeEnabled: false, hasOpencode: true })).toBe(true);
    expect(agentIconsShown({ opencodeEnabled: true, hasOpencode: true })).toBe(true);
  });
});
