// 作者への問い合わせの、本物の口（版、gh、伏せる名前）。試験では service.ts に偽物を渡す。

import os from 'node:os';
import path from 'node:path';
import { VERSION } from '../boot/options.ts';
import type { Db } from '../db/open.ts';
import { listProjects } from '../db/queries.ts';
import type { GetLanguage } from '../i18n/language.ts';
import { captureOutput, type CaptureOptions, type Captured } from '../platform/capture.ts';
import { findInDirs, knownDirs, needsShell, splitPathEnv } from '../platform/exec.ts';
import { claudeVersionOf } from '../provider/claude-code/compat/cli.ts';
import { REPORT_REPO } from './github.ts';
import type { ReportServiceDeps } from './service.ts';

type Capture = (file: string, args: string[], o: CaptureOptions) => Promise<Captured>;

const VERSION_TIMEOUT_MS = 5_000;
const CREATE_TIMEOUT_MS = 30_000;

/** コマンドを PATH と既知の置き場から探す。Windows の gh は MSI が Program Files に入れ、PATH が古いままのことがある。 */
export function findTool(name: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string | null {
  const dirs = [...splitPathEnv(env.PATH ?? env.Path, platform), ...knownDirs(env, platform)];
  if (platform === 'win32' && name === 'gh' && env.ProgramFiles) dirs.push(path.join(env.ProgramFiles, 'GitHub CLI'));
  return findInDirs(name, dirs, env, platform);
}

/** OS の種類と版。Windows は os.version() が「Windows 11 Home」のような名前を返すので添える。ほかの OS は長い文を返すので使わない。 */
export function osLabel(platform: NodeJS.Platform = process.platform, release = os.release(), version = os.version()): string {
  return platform === 'win32' ? `${version} ${release}` : `${platform} ${release}`;
}

/** gh の口。見つからない、ログインしていない、作れないを区別して扱う。 */
export function ghClient(bin: string | null, capture: Capture = captureOutput): ReportServiceDeps['gh'] {
  const shell = bin ? needsShell(bin) : false;
  return {
    available: async () => {
      if (!bin) return false;
      try {
        return (await capture(bin, ['auth', 'status', '--hostname', 'github.com'], { timeoutMs: VERSION_TIMEOUT_MS, shell })).code === 0;
      } catch {
        return false;
      }
    },
    create: async (repo, title, body) => {
      if (!bin) throw new Error('gh not found');
      // 本文は標準入力で渡す。argv に載せると、長い本文で上限に当たり、ps からも読める。
      const r = await capture(bin, ['issue', 'create', '--repo', repo, '--title', title, '--body-file', '-'], { timeoutMs: CREATE_TIMEOUT_MS, shell, stdin: body, stderr: true });
      const url = r.stdout.split(/\r?\n/).map((l) => l.trim()).filter((l) => /^https:\/\//.test(l)).pop();
      if (r.code !== 0 || !url) throw new Error(r.stderr.trim() || `gh exit ${r.code}`);
      return url;
    },
  };
}

async function claudeVersion(env: NodeJS.ProcessEnv, capture: Capture): Promise<string | null> {
  const bin = env.HANGAR_CLAUDE_BIN || findTool('claude', env);
  if (!bin) return null;
  try {
    const r = await capture(bin, ['--version'], { timeoutMs: VERSION_TIMEOUT_MS, shell: needsShell(bin) });
    return r.code === 0 ? claudeVersionOf(r.stdout) : null;
  } catch {
    return null;
  }
}

function userName(): string {
  try {
    return os.userInfo().username;
  } catch {
    return '';
  }
}

export function realReportDeps(o: {
  db: Db;
  deviceId: string;
  language: GetLanguage;
  openUrl: (url: string) => Promise<void>;
  env?: NodeJS.ProcessEnv;
  capture?: Capture;
}): ReportServiceDeps {
  const env = o.env ?? process.env;
  const capture = o.capture ?? captureOutput;
  return {
    repo: REPORT_REPO,
    env: async () => ({ hangarVersion: VERSION, claudeVersion: await claudeVersion(env, capture), os: osLabel(), arch: process.arch }),
    redactContext: () => ({
      home: os.homedir(),
      user: userName(),
      host: os.hostname(),
      projects: listProjects(o.db, o.deviceId, []).map((p) => ({ name: p.name, path: p.path ?? '' })),
    }),
    fetch: (url, init) => fetch(url, init),
    // gh は呼ぶたびに探す。hangar を開いたまま gh を入れた人も、次の下書きから使えるようにする。
    gh: {
      available: () => ghClient(findTool('gh', env), capture).available(),
      create: (repo, title, body) => ghClient(findTool('gh', env), capture).create(repo, title, body),
    },
    openUrl: o.openUrl,
    language: o.language,
    now: () => Date.now(),
  };
}
