import { defineConfig } from 'vitest/config';
// 置き場に settings.json の無い試験は、OS の表示言語で始まる（i18n/osLanguage.ts）。機械の言語で答えが割れないよう、日本語の OS として走らせる。
// 英語の OS は、試験の中で vi.stubEnv('HANGAR_OS_LANGUAGE', 'en') として真似る。
export default defineConfig({ test: { name: 'desktop', environment: 'node', include: ['test/**/*.test.ts'], testTimeout: 60_000, env: { HANGAR_OS_LANGUAGE: 'ja' } } });
