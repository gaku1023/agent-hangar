import path from 'node:path';
import { opencodeBaseEnv } from '../opencode/serve/env.ts';

/**
 * codex に渡す空の環境（決定 14）。opencode と同じ土台（HOME、USER、LANG、XDG の置き場と固定の最小の PATH。Windows は許可リスト）に、
 * codex の置き場と、hangar 自身が使っている node の置き場を PATH へ足す。
 * codex は、どのモデルも code mode（シェルも MCP も JS の exec 経由）で道具を動かし、node が PATH に無いと道具が使えない。
 * ~/.codex は変えない（CODEX_HOME は渡さない。利用者のログインと設定で動かす）。
 * 呼び手の印（CLAUDE で始まる鍵、HANGAR_*）は、許可リストの外なので入らない。
 */
export function codexBaseEnv(bin: string, src: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, nodeExec: string = process.execPath): NodeJS.ProcessEnv {
  const env = opencodeBaseEnv(bin, src, platform);
  const sep = platform === 'win32' ? ';' : ':';
  const dirOf = platform === 'win32' ? path.win32.dirname : path.posix.dirname;
  const nodeDir = dirOf(nodeExec);
  const key = Object.keys(env).find((k) => k.toLowerCase() === 'path') ?? 'PATH';
  const parts = (env[key] ?? '').split(sep).filter(Boolean);
  if (!parts.includes(nodeDir)) parts.push(nodeDir);
  env[key] = parts.join(sep);
  return env;
}
