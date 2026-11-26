import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { findFieldRange, findReplyRange, pillOf, replyStream } from './termReplyMatch.ts';

// 2026-11-25 に Claude Code 2.1.332 を幅 80 の tmux で動かし、capture-pane で採った画面と、会話の JSONL の本文。
const REPLY = '## What is a tmux session?\n\nA tmux session is a background terminal workspace that keeps running after you disconnect. Each session contains one or more windows, and each window can be split into panes that run shell programs.\n\n- Sessions keep running when you close your terminal or lose an SSH connection, so long jobs such as builds, downloads, and training runs are not killed by a network drop or a closed laptop lid.\n- Each session has a name, and you can keep several sessions going at once, list them, and switch between them.\n- Windows and panes let you arrange several shells side by side inside one session.\n\nTo use one, you usually:\n\n1. Create a named session with `tmux new -s work`, then detach from it with `Ctrl-b d`.\n2. Reconnect later with `tmux attach -t work` (or plain `tmux attach` if there is only one session) to pick up where you left off.\n\nIn short, a tmux session is a detachable terminal workspace: you can leave it running and return to it whenever you need.';
const SCREEN = [
  '❯ Without using any tools, answer in English in about 150 words: explain what a',
  '  tmux session is.',
  '',
  '⏺ What is a tmux session?',
  '',
  '  A tmux session is a background terminal workspace that keeps running after you',
  '  disconnect. Each session contains one or more windows, and each window can be',
  '  split into panes that run shell programs.',
  '',
  '  - Sessions keep running when you close your terminal or lose an SSH',
  '    connection, so long jobs such as builds, downloads, and training runs are',
  '    not killed by a network drop or a closed laptop lid.',
  '  - Each session has a name, and you can keep several sessions going at once,',
  '    list them, and switch between them.',
  '  - Windows and panes let you arrange several shells side by side inside one',
  '    session.',
  '',
  '  To use one, you usually:',
  '',
  '  1. Create a named session with tmux new -s work, then detach from it with',
  '     Ctrl-b d.',
  '  2. Reconnect later with tmux attach -t work (or plain tmux attach if there is',
  '     only one session) to pick up where you left off.',
  '',
  '  In short, a tmux session is a detachable terminal workspace: you can leave it',
  '  running and return to it whenever you need.',
  '',
  '✻ Baked for 5s · done 8:04 PM',
  '',
  '────────────────────────────────────────',
  '❯ ',
];

describe('replyStream', () => {
  it('文字と数字だけを小文字で残し、Markdown の記号と空白を落とす', () => {
    expect(replyStream('## Hi `there`, **you**!\n- 1. ok')).toBe('hithereyou1ok');
    expect(replyStream('⏺ 日本語も、残す。')).toBe('日本語も残す');
  });
});

describe('findReplyRange', () => {
  it('⏺ の行から返答の最後の行までを返す', () => {
    expect(findReplyRange(SCREEN, REPLY)).toEqual({ start: 3, end: 25 });
  });

  it('返答のすぐ後に字下げしたツールの行が続いても、返答の終わりで止める', () => {
    const lines = ['⏺ It is waiting on the test run for the width change; meanwhile I am', '  getting a screenshot script ready.', '  Searched for 6 patterns, listed 1 directory', '⏺ Next block'];
    expect(findReplyRange(lines, 'It is waiting on the test run for the width change; meanwhile I am getting a screenshot script ready.')).toEqual({ start: 0, end: 1 });
  });

  it('最後の行の後ろに付いた飾り（ · summary）は許す', () => {
    const lines = ['⏺ The answer is short and ends with a period here.', '  It wraps once. · summary'];
    expect(findReplyRange(lines, 'The answer is short and ends with a period here. It wraps once.')).toEqual({ start: 0, end: 1 });
  });

  it('同じ返答が 2 度あれば、新しい（下の）方を返す', () => {
    const lines = ['⏺ Same reply text goes here twice.', '', '❯ again', '', '⏺ Same reply text goes here twice.'];
    expect(findReplyRange(lines, 'Same reply text goes here twice.')).toEqual({ start: 4, end: 4 });
  });

  it('途中が食い違えば見つからない（描き直しで中身が変わったとき）', () => {
    const broken = [...SCREEN];
    broken[13] = '  - Each session has a label and something else entirely different now,';
    expect(findReplyRange(broken, REPLY)).toBeNull();
  });

  it('頭が画面の上に切れていても、画面の 1 行目から返答の終わりまで合えば、見えている範囲を返す（cut）', () => {
    expect(findReplyRange(SCREEN.slice(5), REPLY)).toEqual({ start: 0, end: 20, cut: true });
  });

  it('頭が切れた側は、画面のいちばん上の文字のある行からしか始めない', () => {
    expect(findReplyRange(['', ...SCREEN.slice(5)], REPLY)).toEqual({ start: 1, end: 21, cut: true });
    expect(findReplyRange(['something unrelated on top', ...SCREEN.slice(5)], REPLY)).toBeNull();
  });

  it('画面のいちばん上に段落の終わりのかけらが 1 行だけ残れば、その行を返す。かけらが短すぎれば扱わない（取り違えやすいため）', () => {
    expect(findReplyRange(SCREEN.slice(25, 27), REPLY)).toEqual({ start: 0, end: 0, cut: true });
    expect(findReplyRange(SCREEN.slice(24, 26), REPLY)).toEqual({ start: 0, end: 1, cut: true });
    expect(findReplyRange(['  need.', ''], REPLY)).toBeNull();
  });

  it('上に貼り付いた指示の行（❯）は飛ばして、その下から頭の切れた返答を探す', () => {
    expect(findReplyRange(['❯ Without using any tools, answer in English', ...SCREEN.slice(5)], REPLY)).toEqual({ start: 1, end: 21, cut: true });
  });

  it('頭が切れていて、途中が食い違えば見つからない', () => {
    const broken = SCREEN.slice(5);
    broken[8] = '  - Each session has a label and something else entirely different now,';
    expect(findReplyRange(broken, REPLY)).toBeNull();
  });

  it('下が画面の端で切れていれば、見えている頭の部分を返す（cutEnd）', () => {
    expect(findReplyRange(SCREEN.slice(0, 15), REPLY)).toEqual({ start: 3, end: 14, cutEnd: true });
  });

  it('下が切れたあとに、返答の続きらしい字下げの行が食い違って続けば見つからない（描き直しで中身が変わった）', () => {
    expect(findReplyRange([...SCREEN.slice(0, 15), '    something entirely different is drawn here now'], REPLY)).toBeNull();
  });

  it('すぐ下の行に「Jump to bottom」の札が重なれば、その行も入れて札の桁を keep で返す', () => {
    const lines = [...SCREEN.slice(0, 15), '    se Jump to bottom ↓'];
    expect(findReplyRange(lines, REPLY)).toEqual({ start: 3, end: 15, cutEnd: true, keep: { from: 6, to: 23 } });
    expect(pillOf(lines[15]!)).toEqual({ from: 6, to: 23 });
    expect(pillOf(SCREEN[5]!)).toBeNull();
  });

  it('続きの段落（head: false）は、空の行の次の字下げした行から始める', () => {
    const para = 'To use one, you usually:';
    expect(findReplyRange(SCREEN, `${para} and something`, { head: false })).toBeNull();
    const body = 'In short, a tmux session is a detachable terminal workspace: you can leave it running and return to it whenever you need.';
    expect(findReplyRange(SCREEN, body, { head: false })).toEqual({ start: 24, end: 25 });
    expect(findReplyRange(SCREEN, body)).toBeNull();
  });

  it('入力欄の行（❯）からは始めない', () => {
    expect(findReplyRange(['❯ Same reply text goes here for the prompt.'], 'Same reply text goes here for the prompt.')).toBeNull();
  });

  it('リンクの URL のように画面で落ちた短いかけらは飛ばしてよい', () => {
    const lines = ['⏺ See the guide for details about the configuration file and', '  its options.'];
    expect(findReplyRange(lines, 'See [the guide](https://example.com/g) for details about the configuration file and its options.')).toEqual({ start: 0, end: 1 });
  });

  it('文字の少ない返答は扱わない（取り違えやすいため）', () => {
    expect(findReplyRange(['⏺ Done.'], 'Done.')).toBeNull();
  });
});

describe('findReplyRange（表）', () => {
  // 2026-11-25 に Claude Code 2.1.332 で採った画面（幅 52 と 100）。表のセルは列の中で折り返すので、行の順に読むと本文の順と食い違う。
  const read = (f: string) => fs.readFileSync(new URL(`./__fixtures__/${f}`, import.meta.url), 'utf8').replace(/\n$/, '');
  const reply = read('claude-table-reply.md');
  it.each([['claude-table-52.txt', 6, 30], ['claude-table-100.txt', 3, 19]])('%s', (file, start, end) => {
    const lines = read(file).split('\n');
    expect(findReplyRange(lines, reply)).toEqual({ start, end });
  });
});

describe('findReplyRange（頭が切れた画面）', () => {
  // 2026-11-25 に Claude Code 2.1.332 を幅 80、高さ 24 の tmux で動かし、長い返答の頭が画面の上に切れたところを capture-pane で採った。
  const read = (f: string) => fs.readFileSync(new URL(`./__fixtures__/${f}`, import.meta.url), 'utf8').replace(/\n$/, '');
  it('見えている返答の下の部分の範囲を返す', () => {
    const lines = read('claude-cut-80.txt').split('\n');
    expect(findReplyRange(lines, read('claude-cut-reply.md'))).toEqual({ start: 0, end: 15, cut: true });
  });
  it('ほかの返答とは合わない', () => {
    const lines = read('claude-cut-80.txt').split('\n');
    expect(findReplyRange(lines, read('claude-table-reply.md'))).toBeNull();
  });
});

// 2026-11-26 に Claude Code 2.1.332 を幅 110 の tmux で動かし、AskUserQuestion の札を capture-pane で採った画面。
const CARD = [
  '──────────────────────────────────────────────────────────────────────────────────────────────────────────────',
  ' ☐ Session',
  '',
  '│ Both reverse-direction checks passed (answering Windows Codex and opencode cards from the Mac). The Codex',
  '│ bug found during them is fixed and shipped as v0.23.1. What should I do with this session?',
  '',
  '❯ 1. Done',
  '     The release is finished. The mobile check stays recorded in memory as unverified.',
  '  2. Paused',
  '     Come back tomorrow to check the conversation page on a real phone.',
  '  3. Keep going',
  '     Carry on in this session (e.g. walk through the mobile check together).',
  '  4. Type something.',
  '──────────────────────────────────────────────────────────────────────────────────────────────────────────────',
  '  5. Chat about this',
];
const Q = 'Both reverse-direction checks passed (answering Windows Codex and opencode cards from the Mac). The Codex bug found during them is fixed and shipped as v0.23.1. What should I do with this session?';

describe('findFieldRange', () => {
  it('札の問いは │ の内側から、折り返した行まで返す', () => {
    expect(findFieldRange(CARD, Q)).toEqual({ start: 3, end: 4, x: 2 });
  });

  it('選択肢の説明は、字下げの後ろから返す', () => {
    expect(findFieldRange(CARD, 'Come back tomorrow to check the conversation page on a real phone.')).toEqual({ start: 9, end: 9, x: 5 });
  });

  it('文の途中から始まる行や、画面に無い文は見つけない', () => {
    expect(findFieldRange(CARD, 'checks passed (answering Windows Codex and opencode cards from the Mac).')).toBeNull();
    expect(findFieldRange(CARD, 'Nothing like this is on the screen at all today.')).toBeNull();
  });

  it('同じ文がいくつもあれば、いちばん下を返す（指示の欄に同じ文を書いたときなど）', () => {
    const lines = ['  The release is finished. The mobile check stays recorded in memory as unverified.', ...CARD];
    expect(findFieldRange(lines, 'The release is finished. The mobile check stays recorded in memory as unverified.')).toEqual({ start: 8, end: 8, x: 5 });
  });
});
