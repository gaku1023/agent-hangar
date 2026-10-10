import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach } from 'vitest';
import { cleanup } from '@testing-library/react';
import { MAC_UA, setClientUserAgent } from './client.ts';

// vitest の globals を使わないので、Testing Library の自動 cleanup が効かない。
// テストごとに描画した木を確実に外すため、jsdom 環境のときだけ明示的に登録する。
if (typeof document !== 'undefined') {
  afterEach(() => cleanup());
}

// 試験は macOS の画面として走らせる（⌘ の表示と打鍵）。Windows と Linux の振る舞いは、試験の中で名乗りを替えて確かめる。
// 替えた名乗りが次の試験へ残らないよう、試験ごとに戻す。
setClientUserAgent(MAC_UA);
beforeEach(() => setClientUserAgent(MAC_UA));
