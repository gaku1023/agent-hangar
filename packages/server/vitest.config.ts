import { defineConfig } from 'vitest/config';

// Windows はプロセスの起動とファイルの読み書きが遅く、GitHub Actions のランナーでは既定の 5 秒に届く試験が出る
// （実測：db.test の 1 件が 5.3 秒）。Windows でだけ上限を延ばす。
// ファイルの DB を何度も開く試験（開くたびにマイグレーションの前の控えを VACUUM INTO と fsync で取る）は、
// 混んだランナーで 1 件 24〜48 秒かかった（session_notes の移し替えの試験、手元の macOS では 0.1 秒）。
// Windows の試験の DB は fsync を省く（test/setup-sqlite.ts）。fsync が混んだディスクで数秒から数十秒かかり、並んで走る別の試験まで締め切りを越えたため。
const testTimeout = process.platform === 'win32' ? 60_000 : 5_000;
// 準備の hook（beforeEach で試験の世界を組むもの）も同じ遅さに当たる。既定の 10 秒のままだと、Windows の混んだランナーで
// prompt.test の beforeEach が 10 秒を越えて落ちた（2026-10-13、main の CI）。Windows でだけ試験と同じ上限にそろえる。
const hookTimeout = process.platform === 'win32' ? 60_000 : 10_000;
// 置き場に settings.json の無い試験は、OS の表示言語で始まる（i18n/osLanguage.ts）。機械の言語で答えが割れないよう、日本語の OS として走らせる。
// 英語の OS は、試験の中で vi.stubEnv('HANGAR_OS_LANGUAGE', 'en') として真似る。
export default defineConfig({ test: { name: 'server', environment: 'node', include: ['src/**/*.test.ts', 'test/**/*.test.ts'], testTimeout, hookTimeout, setupFiles: ['./test/setup-sqlite.ts'], env: { HANGAR_OS_LANGUAGE: 'ja' } } });
