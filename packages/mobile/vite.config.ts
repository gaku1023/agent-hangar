import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

// _headers は assets の根（dist）に置かれて初めて効く。出力は dist/app なので、build の後に 1 つ上へ写す。
// public/ に置くと dist/app/_headers になり、効かない上に /app/_headers として公開されてしまう。
const headersFile: Plugin = {
  name: 'hangar-headers',
  apply: 'build',
  closeBundle() {
    fs.copyFileSync(fileURLToPath(new URL('./_headers', import.meta.url)), fileURLToPath(new URL('./dist/_headers', import.meta.url)));
  },
};

// スマホの画面は Worker の静的ファイルとして /app/ に置く（API は同じオリジンの /m/）。
// 出力を dist/app にするのは、Worker の assets の根を dist にして /app/ の下に配るため。
export default defineConfig({
  base: '/app/',
  plugins: [react(), headersFile],
  server: { host: '127.0.0.1', port: 5175, strictPort: true },
  build: { outDir: 'dist/app', emptyOutDir: true, sourcemap: false },
});
