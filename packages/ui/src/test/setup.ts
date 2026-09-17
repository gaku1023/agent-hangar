import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

// vitest の globals を使わないので、Testing Library の自動 cleanup が効かない。
// テストごとに描画した木を確実に外すため、jsdom 環境のときだけ明示的に登録する。
if (typeof document !== 'undefined') {
  afterEach(() => cleanup());
}
