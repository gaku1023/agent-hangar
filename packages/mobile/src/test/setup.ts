import '@testing-library/jest-dom/vitest';
import 'fake-indexeddb/auto';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// vitest の globals を使わないので、Testing Library の自動 cleanup が効かない。試験ごとに描画した木を外す。
afterEach(() => cleanup());
