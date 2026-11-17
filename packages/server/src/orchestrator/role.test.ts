import { describe, expect, it } from 'vitest';
import { LANGUAGES } from '@agent-hangar/shared';
import { FORBIDDEN_JA } from '../../../shared/src/i18n/forbiddenJa.ts';
import { ORCHESTRATOR_PERMISSIONS, orchestratorCwd, orchestratorInstructions } from './role.ts';

describe('役の文', () => {
  it('どの言語にもあり、[hangar] と [voice] の扱いを書く', () => {
    for (const lang of LANGUAGES) {
      const [e, ...rest] = orchestratorInstructions(lang);
      expect(rest).toEqual([]);
      expect(e!.key).toBe('orchestrator');
      expect(e!.text).toContain('`[hangar]`');
      expect(e!.text).toContain('`[voice]`');
      expect(e!.text).toContain('answer_ask');
      expect(e!.text.endsWith('\n')).toBe(true);
    }
  });
  it('声の印の意味、聞き違いの扱い、弱いターンで断られたときの返し方を書く', () => {
    const [ja, en] = [orchestratorInstructions('ja')[0]!.text, orchestratorInstructions('en')[0]!.text];
    for (const t of [ja, en]) {
      expect(t).toContain('`[voice:window]`');
      expect(t).toContain('list_sessions');
    }
    expect(ja).toContain('聞き違い');
    expect(ja).toContain('聞き返');
    expect(ja).toContain('キーを使って');
    expect(en).toContain('mishear');
    expect(en).toContain('ask back');
    expect(en).toContain('pressing the key');
  });
  it('人格の名前と口調を足せる。口調が空なら何も足さず、権限と安全の文は変わらない', () => {
    for (const lang of LANGUAGES) {
      const base = orchestratorInstructions(lang)[0]!.text;
      expect(orchestratorInstructions(lang, { name: 'ミナ', tone: '' })[0]!.text).toBe(base);
      expect(orchestratorInstructions(lang, null)[0]!.text).toBe(base);
      const withTone = orchestratorInstructions(lang, { name: 'ミナ', tone: 'ていねい' })[0]!.text;
      expect(withTone.startsWith(base)).toBe(true);
      expect(withTone).toContain('ミナ');
      expect(withTone).toContain('ていねい');
      expect(withTone.endsWith('\n')).toBe(true);
    }
  });
  it('人格の文は口調と名前だけの希望として枠付けし、権限と安全の決まりは変えないと書く', () => {
    const ja = orchestratorInstructions('ja', { name: 'ミナ', tone: 'ていねい' })[0]!.text;
    const en = orchestratorInstructions('en', { name: 'Mina', tone: 'polite' })[0]!.text;
    const jaExtra = ja.slice(orchestratorInstructions('ja')[0]!.text.length);
    const enExtra = en.slice(orchestratorInstructions('en')[0]!.text.length);
    expect(jaExtra).toContain('口調と名前だけの希望');
    expect(jaExtra).toContain('権限と安全の決まりは変えない');
    expect(enExtra).toContain('only a preference for your name and tone');
    expect(enExtra).toContain('does not change any permission or safety rule');
  });
  it('自分で片付けた許可と、前のターンで伝えた待ちは黙る。伝えることが無ければ何も書かずに終える', () => {
    const [ja, en] = [orchestratorInstructions('ja')[0]!.text, orchestratorInstructions('en')[0]!.text];
    expect(ja).toContain('返答は書かず');
    expect(ja).toContain('前のターンで伝えた');
    expect(en).toContain('write no reply');
    expect(en).toContain('already told the user');
  });
  it('今の会話に無いことを指されたら、答える前に search_sessions で調べ、見つからなければそう言う', () => {
    const [ja, en] = [orchestratorInstructions('ja')[0]!.text, orchestratorInstructions('en')[0]!.text];
    for (const t of [ja, en]) {
      expect(t).toContain('search_sessions');
      expect(t).toContain('get_transcript');
      expect(t).toContain('`orchestrator: true`');
    }
    expect(ja).toContain('答える前に');
    expect(ja).toContain('見つからなかった');
    expect(en).toContain('before you answer');
    expect(en).toContain('could not find');
  });
  it('日本語と英語は別の文で、日本語はやめた語を含まない', () => {
    const [ja, en] = [orchestratorInstructions('ja')[0]!.text, orchestratorInstructions('en')[0]!.text];
    expect(ja).not.toBe(en);
    expect(/[ぁ-ん]/.test(ja)).toBe(true);
    expect(/[ぁ-ん]/.test(en)).toBe(false);
    for (const f of FORBIDDEN_JA) expect(f.pattern.test(ja), String(f.pattern)).toBe(false);
  });
});

describe('統括の置き場と禁止', () => {
  it('cwd は hangar の置き場の下の orchestrator', () => {
    expect(orchestratorCwd('/h')).toMatch(/[\\/]h[\\/]orchestrator$/);
  });
  it('手を動かす道具を禁じ、hangar の道具だけを許す', () => {
    expect(ORCHESTRATOR_PERMISSIONS.deny).toEqual(expect.arrayContaining(['Bash', 'Edit', 'Write', 'NotebookEdit', 'WebFetch']));
    expect(ORCHESTRATOR_PERMISSIONS.allow).toEqual(['mcp__hangar']);
  });
});
