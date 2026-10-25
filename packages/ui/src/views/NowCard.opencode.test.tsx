import { render } from '@testing-library/react';
import { translator, type TranscriptEvent } from '@agent-hangar/shared';
import { describe, expect, it, vi } from 'vitest';
import { ActionRoot } from '../action/chain.tsx';
import { contextTokensLabel } from '../presenters/format.ts';
import { presentNowCard, type CardInput } from '../presenters/live.ts';
import { NowCard } from './NowCard.tsx';
import { LanguageRoot } from './primitives/language.tsx';

// opencode の会話の「いま」の札（計画の C5、試作の C1）。Claude の会話の札は変えない。
const ja = translator('ja');
const en = translator('en');

const user = (seq: number, text: string): TranscriptEvent => ({ kind: 'user', seq, text, ts: 0 });
const intent = { text: 'pytest の雛形を 3 本書き、conftest に fixture をまとめる。', at: 0, stepsSince: 1, inThisTurn: true };
const usage = { contextPercent: 34, contextTokens: 13_600, costUsd: 0, model: 'lmstudio/qwen3.8-27b' };
const input = (p: Partial<CardInput> = {}): CardInput => ({
  digest: { sessionId: 's1', turnStartSeq: 0, intent: null, agents: [] }, events: [], turnFrom: 0, live: 'busy',
  activity: null, now: 120_000, viewingAgent: false, clock: () => '03:52', idleFor: '3 分', waited: '4 分', artifacts: [], ...p,
});
const oc = (p: Partial<CardInput> = {}): CardInput => input({ agent: 'opencode', usage, firstTurn: true, ...p });

function mount(i: CardInput, language: 'ja' | 'en' = 'ja') {
  const props = presentNowCard(i, language === 'ja' ? ja : en);
  const view = render(<LanguageRoot language={language}><ActionRoot onAction={vi.fn()}><NowCard sessionId="s1" {...props} /></ActionRoot></LanguageRoot>);
  return { props, card: view.container.querySelector('.now-card')! };
}

describe('opencode の会話の意図', () => {
  it('このターンの意図があれば「opencode の意図 · 時刻」の見出しで出す', () => {
    const { card } = mount(oc({ digest: { sessionId: 's1', turnStartSeq: 0, intent, agents: [] } }));
    expect(card.querySelector('.nc-intent-label')?.textContent).toBe('opencode の意図 · 03:52');
    expect(card.querySelector('.nc-intent-text')?.textContent).toBe(intent.text);
    expect(card.querySelector('.nc-intent')?.getAttribute('title')).toBe('opencode が記入、03:52、以降のツール呼び出し 1 回');
  });

  it('意図が無ければ、最初のターンは依頼を「初期プロンプト」の見出しで出す（モデルが MCP を呼ばなくても困らない）', () => {
    const { card } = mount(oc({ events: [user(0, 'tests/ に pytest の雛形を 3 本書いて。')] }));
    expect(card.querySelector('.nc-request-label')?.textContent).toBe('初期プロンプト');
    expect(card.querySelector('.nc-request-text')?.textContent).toBe('tests/ に pytest の雛形を 3 本書いて。');
    expect(card.querySelector('.nc-intent-none')).toBeNull();
  });

  it('本文がまだ届いていなければ、会話の最初の依頼（firstPrompt）を「初期プロンプト」で出す', () => {
    const { card } = mount(oc({ events: [], firstPrompt: 'README を英訳して' }));
    expect(card.querySelector('.nc-request-label')?.textContent).toBe('初期プロンプト');
    expect(card.querySelector('.nc-request-text')?.textContent).toBe('README を英訳して');
  });

  it('2 ターン目からは、そのターンの依頼を「プロンプト · 時刻」で出す', () => {
    const { card } = mount(oc({ firstTurn: false, events: [user(5, 'テストも直して')], turnFrom: 5 }));
    expect(card.querySelector('.nc-request-label')?.textContent).toBe('プロンプト · 03:52');
    expect(card.querySelector('.nc-request-text')?.textContent).toBe('テストも直して');
  });

  it('前のターンの意図しか無いときも、このターンの依頼を出す（「このターンの意図は未記入」は出さない）', () => {
    const { card } = mount(oc({ firstTurn: false, events: [user(5, '続けて')], turnFrom: 5, digest: { sessionId: 's1', turnStartSeq: 5, intent: { ...intent, inThisTurn: false }, agents: [] } }));
    expect(card.querySelector('.nc-request-text')?.textContent).toBe('続けて');
    expect(card.textContent).not.toContain('未記入');
  });

  it('liveHints（Claude の設定）が切でも、意図があれば意図を出す', () => {
    const { card } = mount(oc({ liveHints: false, digest: { sessionId: 's1', turnStartSeq: 0, intent, agents: [] } }));
    expect(card.querySelector('.nc-intent-label')?.textContent).toBe('opencode の意図 · 03:52');
  });
});

describe('opencode の会話の許可と質問', () => {
  it('shell の許可は「許可を待っています · shell」と命令を出す。答えるボタンは置かない', () => {
    const { card } = mount(oc({ live: 'waiting', reason: 'permission', permission: { tool: 'shell', input: 'uv run pytest -q tests/', description: null } }));
    expect(card.querySelector('.nc-stop-head')?.textContent).toBe('許可を待っています · shell');
    expect(card.querySelector('.nc-stop-cmd')?.textContent).toBe('uv run pytest -q tests/');
    expect(card.querySelectorAll('button')).toHaveLength(0);
  });

  it('中身が届いていない許可は「許可を待っています」だけを見出しにする', () => {
    const { card } = mount(oc({ live: 'waiting', reason: 'permission', permission: null }));
    expect(card.querySelector('.nc-stop-head')?.textContent).toBe('許可を待っています');
  });

  it('質問は「opencode からの質問」の見出しで中身だけを出す', () => {
    const { card } = mount(oc({ live: 'waiting', activity: { tool: 'AskUserQuestion', summary: 'q', question: 'fixture はどこに置きますか？' } }));
    expect(card.querySelector('.nc-question-label')?.textContent).toBe('opencode からの質問');
    expect(card.querySelector('.nc-question-text')?.textContent).toBe('fixture はどこに置きますか？');
    expect(card.querySelectorAll('button')).toHaveLength(0);
  });
});

describe('opencode の会話の使用量', () => {
  it('札の下に、コンテキストの帯と、トークン・コスト・モデルの小札を出す', () => {
    const { card } = mount(oc());
    const u = card.querySelector('.nc-usage')!;
    expect(u.querySelector('.nc-usage-label')?.textContent).toBe('コンテキスト');
    expect(u.querySelector('.nc-usage-pct')?.textContent).toBe('34%');
    expect((u.querySelector('.nc-usage-meter i') as HTMLElement).style.width).toBe('34%');
    expect([...u.querySelectorAll('.nc-usage-chip')].map((c) => c.textContent)).toEqual(['13.6k トークン', '$0.00', 'lmstudio/qwen3.8-27b']);
  });

  it('上限が分からない（割合が無い）ときは帯を出さず、小札だけを出す', () => {
    const { card } = mount(oc({ usage: { ...usage, contextPercent: null } }));
    expect(card.querySelector('.nc-usage-meter')).toBeNull();
    expect([...card.querySelectorAll('.nc-usage-chip')].map((c) => c.textContent)).toEqual(['13.6k トークン', '$0.00', 'lmstudio/qwen3.8-27b']);
  });

  it('届いていない値の小札は出さず、何も無ければ欄ごと出さない', () => {
    expect([...mount(oc({ usage: { contextPercent: null, contextTokens: null, costUsd: null, model: 'opencode/glm-5.3-flash-free' } })).card.querySelectorAll('.nc-usage-chip')].map((c) => c.textContent)).toEqual(['opencode/glm-5.3-flash-free']);
    expect(mount(oc({ usage: { contextPercent: null, contextTokens: null, costUsd: null, model: null } })).card.querySelector('.nc-usage')).toBeNull();
  });

  it('割合は 0〜100 に収め、英語では tokens と言う', () => {
    const { card } = mount(oc({ usage: { ...usage, contextPercent: 130.4 } }), 'en');
    expect(card.querySelector('.nc-usage-pct')?.textContent).toBe('130%');
    expect((card.querySelector('.nc-usage-meter i') as HTMLElement).style.width).toBe('100%');
    expect(card.querySelector('.nc-usage-label')?.textContent).toBe('Context');
    expect(card.querySelector('.nc-usage-chip')?.textContent).toBe('13.6k tokens');
  });

  it('トークンの数は 1000 未満はそのまま、10 万未満は小数 1 桁の k、それ以上は k と M', () => {
    expect([950, 1_000, 13_600, 99_960, 136_400, 1_200_000].map(contextTokensLabel)).toEqual(['950', '1k', '13.6k', '100k', '136k', '1.2M']);
  });
});

describe('Claude の会話の札は変わらない', () => {
  it('見出しは Claude のまま、使用量の欄は出さない（使用量を渡しても）', () => {
    const { card, props } = mount(input({ usage, digest: { sessionId: 's1', turnStartSeq: 0, intent, agents: [] } }));
    expect(card.querySelector('.nc-intent-label')?.textContent).toBe('Claude の意図 · 03:52');
    expect(card.querySelector('.nc-usage')).toBeNull();
    expect(props.usage).toBeNull();
  });

  it('許可と質問の見出しも Claude のまま', () => {
    expect(mount(input({ live: 'waiting', reason: 'permission', permission: { tool: 'Bash', input: 'ls', description: null } })).card.querySelector('.nc-stop-head')?.textContent).toBe('Claude が求めている許可 · Bash');
    expect(mount(input({ live: 'waiting', activity: { tool: 'AskUserQuestion', summary: 'q', question: 'どうしますか？' } })).card.querySelector('.nc-question-label')?.textContent).toBe('Claude からの質問');
  });

  it('意図が無いときは「意図は未記入」のまま（初期プロンプトにしない）', () => {
    const { card } = mount(input({ events: [user(0, 'やって')], firstPrompt: 'やって', firstTurn: true }));
    expect(card.querySelector('.nc-intent-none')?.textContent).toBe('意図は未記入');
    expect(card.querySelector('.nc-request-label')).toBeNull();
  });
});
