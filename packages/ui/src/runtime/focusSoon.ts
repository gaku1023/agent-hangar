/**
 * フォーカスの対象と、それを持つ要素の id の対応。
 * ターミナルは DOM の id では掴めないので、TerminalHost が別に受け持つ。
 */
export const FOCUS_IDS = { search: 'global-search', newSessionName: 'new-session-name', palette: 'palette-input', promoteName: 'promote-name', todoInput: 'todo-input', results: 'session-results' } as const;

/**
 * 何枚目の描画まで探すか。
 * 画面の移り変わりを View Transitions で包むと、描き替えが 1 から 2 枚遅れる。それでも間に合う数にしてある。
 */
export const FOCUS_TRIES = 10;

/** 要素が現れるまで、次の描画ごとに探してフォーカスを当てる。現れなければ FOCUS_TRIES 枚でやめる。 */
export function focusSoon(find: () => HTMLElement | null, nextFrame: (cb: () => void) => void, tries = FOCUS_TRIES): void {
  nextFrame(() => {
    const el = find();
    if (el) el.focus();
    else if (tries > 1) focusSoon(find, nextFrame, tries - 1);
  });
}
