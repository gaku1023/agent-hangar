import { describe, expect, it } from 'vitest';
import { promptHead } from '@agent-hangar/shared';
import { jumpToPrompt, leaveTranscript, promptVisible, type PaneIo } from './promptJump.ts';

const TRANSCRIPT_FOOTER = '  Showing detailed transcript · ctrl+o to toggle · ↑↓ scroll · v to open in code · ? for shortcuts              verbose';
const NORMAL_FOOTER = '  ⏵⏵ auto mode on (shift+tab to cycle)';

/**
 * fullscreen の Claude Code を真似る。transcript では pos の指示を画面の上に出し、{ と } で 1 つずつ動く。
 * G は最後の指示より下（返答の末尾）へ行くので、そこから { を 1 回押すと最後の指示に着く。これは実機で確かめた動きである。
 * 通常の画面で送られた文字は入力欄に入ったものとして typed に積む。テストはこれが空であることを確かめる。
 */
function fakeClaude(prompts: string[], opts: { transcript?: boolean; ignoreCtrlO?: boolean; dropToNormalAfter?: number } = {}) {
  let transcript = opts.transcript ?? false;
  let pos = prompts.length;
  let sent = 0;
  const typed: string[] = [];
  const keys: string[] = [];
  const io: PaneIo = {
    capture: () => transcript
      ? [pos < prompts.length ? `❯ ${prompts[pos]}` : '⏺ 最後の返事', '', '⏺ 返事', '', pos + 1 < prompts.length ? `❯ ${prompts[pos + 1]}` : '', '', TRANSCRIPT_FOOTER].join('\n')
      : ['⏺ 返事', '', '❯ ', NORMAL_FOOTER, ''].join('\n'),
    send: (key) => {
      keys.push(key);
      sent++;
      if (key === 'C-o') { if (!opts.ignoreCtrlO) transcript = !transcript; }
      else if (!transcript) typed.push(key);
      else if (key === 'G') pos = prompts.length;
      else if (key === 'g') pos = 0;
      else if (key === '{') pos = Math.max(pos - 1, 0);
      else if (key === '}') pos = Math.min(pos + 1, prompts.length);
      else if (key === 'q') transcript = false;
      // 送ったキーを受けたあとで、利用者の操作などにより通常の画面へ戻ったことにする。
      if (opts.dropToNormalAfter !== undefined && sent >= opts.dropToNormalAfter) transcript = false;
    },
    sleep: async () => {},
  };
  return { io, typed, keys, at: () => prompts[pos], inTranscript: () => transcript };
}

const PROMPTS = ['最初の指示です', 'おお、治った', '端で一旦止まって、もう一回左でって感じじゃない？', 'OKこれでコミットして', 'y'];
const heads = (ps: string[]) => ps.map(promptHead);

describe('jumpToPrompt', () => {
  it('transcript に入り、目的の指示へ跳ぶ', async () => {
    const c = fakeClaude(PROMPTS);
    expect(await jumpToPrompt(c.io, heads(PROMPTS), 3, 'bottom')).toEqual({ found: true });
    expect(c.at()).toBe('OKこれでコミットして');
    // 新しい側の指示なので末尾から数える。
    expect(c.keys.slice(0, 2)).toEqual(['C-o', 'G']);
    expect(c.typed).toEqual([]);
  });

  it('すでに transcript にいるときは ctrl+o を押さない', async () => {
    const c = fakeClaude(PROMPTS, { transcript: true });
    await jumpToPrompt(c.io, heads(PROMPTS), 4, 'bottom');
    expect(c.keys).not.toContain('C-o');
    expect(c.at()).toBe('y');
  });

  it('Claude Code が描かない指示がいくつあっても、見えている指示から位置を割り出して合わせる', async () => {
    // hangar は 3 つ余分に数えている。数えたとおりに { を押すと、目的より 3 つ古い側に着く。
    const shown = ['一', '二', '三', '四', 'おお、治った', '五', '六', '七', 'y'];
    const counted = ['一', '二', '三', '四', 'おお、治った', '幻 1', '五', '幻 2', '六', '幻 3', '七', 'y'];
    const c = fakeClaude(shown);
    expect(await jumpToPrompt(c.io, heads(counted), 4, 'bottom')).toEqual({ found: true });
    // 画面には指示が 2 つ見えるので、目的の指示が画面に出ていれば着いたとみなす。
    expect(promptVisible(c.io.capture(), 'おお、治った')).toBe(true);
    expect(c.typed).toEqual([]);
  });

  it('描かれない指示が数えた側に無いときは、新しい側から寄せる', async () => {
    const shown = ['一', '二', 'おお、治った', '隠れ 1', '隠れ 2', '三', 'y'];
    const counted = ['一', '二', 'おお、治った', '三', 'y'];
    const c = fakeClaude(shown);
    expect(await jumpToPrompt(c.io, heads(counted), 2, 'bottom')).toEqual({ found: true });
    expect(c.at()).toBe('おお、治った');
  });

  it('同じ書き出しの指示が 2 つあっても、数えた位置に近いほうへ着く', async () => {
    const ps = ['一', '二', 'おお、治った', '三', '四', '五', 'おお、治った', '六'];
    const c = fakeClaude(ps);
    // 末尾から 2 つ目の「おお、治った」へ。途中で古いほうの同じ指示に当てて動き直したりしない。
    expect(await jumpToPrompt(c.io, heads(ps), 6, 'bottom')).toEqual({ found: true });
    expect(c.keys.filter((k) => k === '{').length).toBe(2);
    expect(c.keys).not.toContain('}');
  });

  it('会話の途中から始まる切り出しでも、末尾から数えて着く', async () => {
    const ps = ['一', '二', '三', '四', '五', '六', '七', '八'];
    const c = fakeClaude(ps);
    // UI はまだ古い側を読み込んでいないので、後ろの 4 つしか知らない。
    expect(await jumpToPrompt(c.io, heads(ps.slice(4)), 1, 'bottom')).toEqual({ found: true });
    expect(c.at()).toBe('六');
  });

  it('古い側の指示へは先頭から数える', async () => {
    const ps = ['一', '二', '三', '四', '五', '六', '七', '八'];
    const c = fakeClaude(ps);
    expect(await jumpToPrompt(c.io, heads(ps), 2, 'top')).toEqual({ found: true });
    expect(c.at()).toBe('三');
    expect(c.keys.slice(0, 2)).toEqual(['C-o', 'g']);
    expect(c.keys.filter((k) => k === '}').length).toBe(2);
  });

  it('長い指示は書き出しで見つける', async () => {
    expect(promptHead('端で一旦止まって、もう一回左でって感じじゃない？\n2 行目')).toBe('端で一旦止まって、もう一回左でっ');
    const c = fakeClaude(PROMPTS);
    expect(await jumpToPrompt(c.io, heads(PROMPTS), 2, 'bottom')).toEqual({ found: true });
  });

  it('見つからなければ found は偽で、理由を返す', async () => {
    const c = fakeClaude(PROMPTS);
    const counted = [...heads(PROMPTS.slice(0, 3)), 'どこにも無い指示', ...heads(PROMPTS.slice(3))];
    expect(await jumpToPrompt(c.io, counted, 3, 'bottom')).toEqual({ found: false, reason: 'notFound' });
    expect(c.typed).toEqual([]);
  });

  it('ctrl+o で transcript に入れないときは、それ以上なにも送らない', async () => {
    const c = fakeClaude(PROMPTS, { ignoreCtrlO: true });
    expect(await jumpToPrompt(c.io, heads(PROMPTS), 3, 'bottom')).toEqual({ found: false, reason: 'mode' });
    expect(c.keys).toEqual(['C-o']);
    expect(c.typed).toEqual([]);
  });

  it('途中で transcript を抜けたら、そこで止めて入力欄に文字を入れない', async () => {
    // 利用者が途中で q を押したなどで、3 つ目のキーから先は通常の画面に落ちる。
    const c = fakeClaude(PROMPTS, { dropToNormalAfter: 3 });
    expect(await jumpToPrompt(c.io, heads(PROMPTS), 1, 'bottom')).toEqual({ found: false, reason: 'mode' });
    expect(c.typed).toEqual([]);
  });
});

describe('promptVisible', () => {
  it('❯ の行の書き出しで見る。返答の中に同じ文があっても数えない', () => {
    expect(promptVisible('⏺ おお、治ったとのことです\n❯ 別の指示', 'おお、治った')).toBe(false);
    expect(promptVisible('  ❯ おお、治った\n', 'おお、治った')).toBe(true);
  });
  it('空白の並びの違いは無視する', () => {
    expect(promptVisible('❯ OK  これで　コミット', 'OK これで コミット')).toBe(true);
  });
});

describe('leaveTranscript', () => {
  it('transcript にいれば q で抜ける', async () => {
    const c = fakeClaude(PROMPTS, { transcript: true });
    expect(await leaveTranscript(c.io)).toBe(true);
    expect(c.inTranscript()).toBe(false);
  });
  it('通常の画面では何も送らない', async () => {
    const c = fakeClaude(PROMPTS);
    expect(await leaveTranscript(c.io)).toBe(false);
    expect(c.keys).toEqual([]);
  });
});
