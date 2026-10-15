// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { suppressNativeMenu, type MenuEventLike } from './nativeMenu.ts';

const menu = (target: EventTarget | null): MenuEventLike => ({ target, preventDefault: vi.fn() });
const byId = (id: string) => document.getElementById(id)!;

beforeEach(() => {
  document.body.innerHTML = `
    <main id="plain"><span id="text">見出し</span></main>
    <input id="input"><textarea id="area"></textarea>
    <div id="editable" contenteditable="true"><b id="inEditable">x</b></div>
    <div class="term-host"><div id="inTerm"></div></div>`;
});

describe('suppressNativeMenu', () => {
  it('入力欄でもターミナルでもない場所では、既定のメニュー（Back と Reload）を止める', () => {
    for (const id of ['plain', 'text']) {
      const e = menu(byId(id));
      suppressNativeMenu(e, () => '');
      expect(e.preventDefault).toHaveBeenCalled();
    }
  });
  it('入力欄、contenteditable、ターミナルの中では、貼り付けに要るので既定のメニューを残す', () => {
    for (const id of ['input', 'area', 'editable', 'inEditable', 'inTerm']) {
      const e = menu(byId(id));
      suppressNativeMenu(e, () => '');
      expect(e.preventDefault).not.toHaveBeenCalled();
    }
  });
  it('文字を選んでいるときは、コピーに要るので既定のメニューを残す', () => {
    const e = menu(byId('text'));
    suppressNativeMenu(e, () => '見出し');
    expect(e.preventDefault).not.toHaveBeenCalled();
  });
  it('的が要素でないとき（文書そのもの）も止める', () => {
    const e = menu(document);
    suppressNativeMenu(e, () => '');
    expect(e.preventDefault).toHaveBeenCalled();
  });
});
