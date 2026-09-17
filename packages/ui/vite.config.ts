import react from '@vitejs/plugin-react';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defineConfig } from 'vite';

// 開発時はサーバのトークンを読んでプロキシが Authorization を付ける。
// 本番はクッキーで渡る。
function devToken(): string {
  try { return fs.readFileSync(path.join(process.env.HANGAR_HOME ?? path.join(os.homedir(), '.agent-hangar'), 'token'), 'utf8').trim(); } catch { return ''; }
}

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: 'http://127.0.0.1:4177', headers: { Authorization: `Bearer ${devToken()}` } },
      '/ws': { target: 'ws://127.0.0.1:4177', ws: true, headers: { Authorization: `Bearer ${devToken()}` } },
    },
  },
  build: { outDir: 'dist', sourcemap: true },
});
