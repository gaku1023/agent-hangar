import { createContext } from 'react';
import type { DropDto, PromptCommandDto } from '@agent-hangar/shared';

/**
 * 初期プロンプト欄がサーバに頼むこと。画面は fetch を呼ばないので、Root が api をつないで Context で配る。
 * notify は右下の知らせを出す。
 */
export type PromptAssist = {
  commands(projectId: string | null): Promise<PromptCommandDto[]>;
  files(projectId: string, query: string): Promise<string[]>;
  upload(file: File): Promise<DropDto>;
  existing(paths: string[]): Promise<string[]>;
  notify(message: string): void;
};

/** 添付が使えない場所の、置き場へ送る口が返す失敗。文は使う側が現在の言語で引く（composer.attach.unavailable）。 */
export class AttachUnavailableError extends Error {}

/** Context が無い場所（部品だけの試験など）で使う、何も返さない既定。 */
export const NO_ASSIST: PromptAssist = {
  commands: () => Promise.resolve([]),
  files: () => Promise.resolve([]),
  upload: () => Promise.reject(new AttachUnavailableError('attach unavailable')),
  existing: (paths) => Promise.resolve(paths),
  notify: () => {},
};

export const PromptAssistContext = createContext<PromptAssist>(NO_ASSIST);
