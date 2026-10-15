import { describe, expect, it } from 'vitest';
import { t as translate, translator } from '@agent-hangar/shared';
import { presentInjection } from './injection.ts';

const ja = translator('ja');
const textOf = (pieces: { text: string }[] | { kind: string; text: string }[]) => pieces.map((p) => p.text).join('');

describe('足す指示の全文', () => {
  it('5 つの段に、どのスイッチのものかの名前を添えて、サーバが足す順に並べる', () => {
    const parts = presentInjection(ja, { askStatusAtEnd: true, liveHints: true });
    expect(parts.map((p) => p.label)).toEqual(['基本（常に）', '他の PC で進めたセッションを再開したとき', '2 台以上の PC で使うプロジェクト', '作業の区切りで Done／Paused を確認する（オン）', 'ターンの意図と操作の短い説明を送る（オン）']);
    expect(parts.map((p) => p.off)).toEqual([false, false, false, false, false]);
    // PC をまたぐ 2 段には、同期を使っているときだけ足すことを印で添える。
    expect(parts.map((p) => p.mark)).toEqual([null, '同期を使っているときだけ', '同期を使っているときだけ', null, null]);
  });
  it('PC をまたぐ 2 段も辞書の全文で、差し込む値は印にする', () => {
    const [, handover, multi] = presentInjection(ja, { askStatusAtEnd: true, liveHints: true });
    const tokens = handover!.pieces.filter((p) => p.kind === 'token').map((p) => p.text);
    expect(tokens).toEqual(['前の PC', '前の PC の OS', '最後に使った日時', '前のパス', 'この PC', 'この PC の OS', 'この PC のパス', 'この PC のパス', 'ブランチ', '件数', '見つからないファイルの一覧']);
    expect(textOf(handover!.pieces)).toBe(translate('ja', 'launch.injection.handover', { prevDevice: '前の PC', prevOs: '前の PC の OS', lastAt: '最後に使った日時', prevPath: '前のパス', device: 'この PC', os: 'この PC の OS', path: 'この PC のパス', branch: 'ブランチ', editedCount: '件数', missing: '見つからないファイルの一覧' }));
    expect(multi!.pieces.filter((p) => p.kind === 'token').map((p) => p.text)).toEqual(['台数']);
    expect(textOf(multi!.pieces)).toBe(translate('ja', 'launch.injection.multiDevice', { deviceCount: '台数' }));
  });
  it('本文は辞書の全文で、差し込む値は印にする（設定の画面はプロジェクトに属さない）', () => {
    const [body, , , status, live] = presentInjection(ja, { askStatusAtEnd: true, liveHints: true });
    const tokens = body!.pieces.filter((p) => p.kind === 'token').map((p) => p.text);
    expect(tokens).toEqual(['プロジェクト名', 'パス', 'TODO の一覧']);
    expect(textOf(body!.pieces)).toBe(translate('ja', 'launch.injection.body', { projectName: 'プロジェクト名', projectPath: 'パス', todos: 'TODO の一覧' }));
    expect(textOf(status!.pieces)).toBe(translate('ja', 'launch.injection.status'));
    expect(textOf(live!.pieces)).toBe(translate('ja', 'launch.injection.live'));
  });
  it('切った段は消さずに残し、名前で「足しません」と言う', () => {
    const parts = presentInjection(ja, { askStatusAtEnd: false, liveHints: true });
    expect(parts[3]).toMatchObject({ label: '作業の区切りで Done／Paused を確認する（オフ・追加しません）', off: true });
    expect(parts[4]).toMatchObject({ off: false });
    expect(presentInjection(ja, { askStatusAtEnd: true, liveHints: false })[4]).toMatchObject({ label: 'ターンの意図と操作の短い説明を送る（オフ・追加しません）', off: true });
  });
  it('英語の画面では英語の指示を出す', () => {
    const [body] = presentInjection(translator('en'), { askStatusAtEnd: true, liveHints: true });
    expect(body!.label).toBe('Basics (always)');
    expect(body!.pieces.filter((p) => p.kind === 'token').map((p) => p.text)).toEqual(['project name', 'path', 'TODO list']);
    expect(presentInjection(translator('en'), { askStatusAtEnd: true, liveHints: true })[1]!.mark).toBe('Only when you use sync');
  });
});
