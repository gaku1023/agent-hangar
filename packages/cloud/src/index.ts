import { createApp } from './app.ts';
import { MIN_DEVICE_COMPAT } from './compat.ts';

/**
 * 配備される Worker の入口である。既定の輸出だけを置く。
 * 入口の名前付きの輸出を Workers がどう扱うかは、クラス（Durable Object と WorkerEntrypoint）以外について文書に書かれていない。
 * 組み立ては app.ts に置き、試験は下限を差し替えた Worker を app.ts から組む（test/harness.ts）。
 */
export default createApp({ minDeviceCompat: MIN_DEVICE_COMPAT });
