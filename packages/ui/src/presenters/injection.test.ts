import { describe, expect, it } from 'vitest';
import { t as translate, translator } from '@agent-hangar/shared';
import { presentInjection } from './injection.ts';

const ja = translator('ja');
const textOf = (pieces: { text: string }[] | { kind: string; text: string }[]) => pieces.map((p) => p.text).join('');

describe('足す指示の全文', () => {
  it('3 つの段に、どのスイッチのものかの名前を添えて並べる', () => {
    const parts = presentInjection(ja, { askStatusAtEnd: true, liveHints: true });
    expect(parts.map((p) => p.label)).toEqual(['基本（常に）', '区切りで Done／Paused を聞く（オン）', 'ターンの意図と操作の短い説明を送る（オン）']);
    expect(parts.map((p) => p.off)).toEqual([false, false, false]);
  });
  it('本文は辞書の全文で、差し込む値は印にする（設定の画面はプロジェクトに属さない）', () => {
    const [body, status, live] = presentInjection(ja, { askStatusAtEnd: true, liveHints: true });
    const tokens = body!.pieces.filter((p) => p.kind === 'token').map((p) => p.text);
    expect(tokens).toEqual(['プロジェクト名', 'パス', 'TODO の一覧']);
    expect(textOf(body!.pieces)).toBe(translate('ja', 'launch.injection.body', { projectName: 'プロジェクト名', projectPath: 'パス', todos: 'TODO の一覧' }));
    expect(textOf(status!.pieces)).toBe(translate('ja', 'launch.injection.status'));
    expect(textOf(live!.pieces)).toBe(translate('ja', 'launch.injection.live'));
  });
  it('切った段は消さずに残し、名前で「足しません」と言う', () => {
    const parts = presentInjection(ja, { askStatusAtEnd: false, liveHints: true });
    expect(parts[1]).toMatchObject({ label: '区切りで Done／Paused を聞く（オフ・足しません）', off: true });
    expect(parts[2]).toMatchObject({ off: false });
    expect(presentInjection(ja, { askStatusAtEnd: true, liveHints: false })[2]).toMatchObject({ label: 'ターンの意図と操作の短い説明を送る（オフ・足しません）', off: true });
  });
  it('英語の画面では英語の指示を出す', () => {
    const [body] = presentInjection(translator('en'), { askStatusAtEnd: true, liveHints: true });
    expect(body!.label).toBe('Basics (always)');
    expect(body!.pieces.filter((p) => p.kind === 'token').map((p) => p.text)).toEqual(['project name', 'path', 'TODO list']);
  });
});
