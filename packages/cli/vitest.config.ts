import { defineConfig } from 'vitest/config';

// Windows はプロセスの起動が遅く、CLI を起こす試験が既定の 5 秒に届くことがある。Windows でだけ上限を延ばす。
// DB を開いて控えを取る試験は、混んだランナーで 20 秒を超えた（setup cloud の控えの失敗の試験）。サーバの試験と同じ 60 秒にそろえる。
const testTimeout = process.platform === 'win32' ? 60_000 : 5_000;
// 準備の hook（beforeEach で試験の世界を組むもの）も同じ遅さに当たる。既定の 10 秒のままだと、Windows の混んだランナーで
// prompt.test の beforeEach が 10 秒を越えて落ちた（2026-10-13、main の CI）。Windows でだけ試験と同じ上限にそろえる。
const hookTimeout = process.platform === 'win32' ? 60_000 : 10_000;
// 置き場に settings.json の無い試験は、OS の表示言語で始まる（i18n/osLanguage.ts）。機械の言語で答えが割れないよう、日本語の OS として走らせる。
// 英語の OS は、試験の中で vi.stubEnv('HANGAR_OS_LANGUAGE', 'en') として真似る。
export default defineConfig({ test: { name: 'cli', environment: 'node', include: ['src/**/*.test.ts'], testTimeout, hookTimeout, setupFiles: ['../server/test/setup-sqlite.ts'], env: { HANGAR_OS_LANGUAGE: 'ja' } } });
