import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// スマホの画面は Worker の静的ファイルとして /app/ に置く（API は同じオリジンの /m/）。
// 出力を dist/app にするのは、Worker の assets の根を dist にして /app/ の下に配るため。
export default defineConfig({
  base: '/app/',
  plugins: [react()],
  server: { host: '127.0.0.1', port: 5175, strictPort: true },
  build: { outDir: 'dist/app', emptyOutDir: true, sourcemap: false },
});
