export { installShutdown, startServer, STOP_WATCHDOG_MS, VERSION } from './server.ts';
// CLI が使う名前は cliEntry.ts にまとめてある。CLI はそちらから取る（理由は cliEntry.ts の頭に書いた）。
export * from './cliEntry.ts';
// CLI は使わないが、パッケージの名前としては残す（試験が使う）。
export { stampTranscriptsFrom } from './sync/transcriptsFrom.ts';
