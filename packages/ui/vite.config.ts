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

/**
 * 要求のたびにトークンを読んで付ける。
 * 設定を読んだ時点の値を固定で持つと、初回の起動（置き場がまだ無い）では Vite がサーバより先に立ち上がり、
 * 空のトークンを付け続けて全部の要求が 401 になる。
 */
const withToken = (proxy: { on(event: string, cb: (req: { setHeader(name: string, value: string): void }) => void): void }): void => {
  for (const event of ['proxyReq', 'proxyReqWs']) proxy.on(event, (req) => req.setHeader('Authorization', `Bearer ${devToken()}`));
};

export default defineConfig({
  plugins: [react()],
  server: {
    // 既定の localhost は、Windows では ::1 だけで待ち受けて 127.0.0.1 から開けない。どの OS でも 127.0.0.1 で待つ。
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: 'http://127.0.0.1:4177', configure: withToken },
      '/ws': { target: 'ws://127.0.0.1:4177', ws: true, configure: withToken },
    },
  },
  build: { outDir: 'dist', sourcemap: true },
});
