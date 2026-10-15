// 作者への問い合わせの本文を、作者が直しやすい節の形に組み立てる。

import type { Language } from '@agent-hangar/shared';
import { MessageError, msg, render } from '../i18n/message.ts';

export type ReportKind = 'bug' | 'request';
export type SectionName = 'symptom' | 'steps' | 'cause' | 'fix' | 'notes' | 'problem' | 'proposal' | 'alternatives';
export type ReportInput = { kind: ReportKind; title: string; sections: [SectionName, string][] };
export type ReportEnv = { hangarVersion: string; claudeVersion: string | null; os: string; arch: string };

/** 本文の末尾に入れる印。作者は検索でこれを拾う。形を変えるときは版を上げる。 */
export const REPORT_MARKER = '<!-- via-hangar report v1 -->';

/** 種類ごとの節。並びは本文の並びで、required は無ければ断る。 */
const SECTIONS: Record<ReportKind, { name: SectionName; required: boolean }[]> = {
  bug: [
    { name: 'symptom', required: true }, { name: 'steps', required: true }, { name: 'cause', required: false },
    { name: 'fix', required: false }, { name: 'notes', required: false },
  ],
  request: [
    { name: 'problem', required: true }, { name: 'proposal', required: true }, { name: 'alternatives', required: false },
    { name: 'notes', required: false },
  ],
};

/**
 * 道具の引数を検査して取り出す。種類に無い節は読まない。
 * 空白だけの節は無いものと見る。必須の節が無いか、節が文字列でなければ断る。
 */
export function parseReportInput(args: Record<string, unknown>): ReportInput {
  const kind = args.kind;
  if (kind !== 'bug' && kind !== 'request') throw new MessageError(msg('report.args.kindInvalid'));
  const title = typeof args.title === 'string' ? args.title.trim() : '';
  if (!title) throw new MessageError(msg('report.args.titleRequired'));
  const sections: [SectionName, string][] = [];
  for (const s of SECTIONS[kind]) {
    const v = args[s.name];
    if (v !== undefined && v !== null && typeof v !== 'string') throw new MessageError(msg('common.field.mustBeString', { field: s.name }));
    const text = typeof v === 'string' ? v.trim() : '';
    if (!text) {
      if (s.required) throw new MessageError(msg('report.args.fieldRequired', { field: s.name }));
      continue;
    }
    sections.push([s.name, text]);
  }
  return { kind, title, sections };
}

/** 題名と本文を組み立てる。題名の頭に種類を付け（付いていれば重ねない）、節、環境、印の順に並べる。 */
export function composeReport(input: ReportInput, env: ReportEnv, language: Language): { title: string; body: string } {
  const prefix = `[${input.kind}]`;
  const title = input.title.toLowerCase().startsWith(prefix) ? input.title : `${prefix} ${input.title}`;
  const lines: string[] = [];
  for (const [name, text] of input.sections) lines.push(`## ${render(language, msg(`report.section.${name}`))}`, '', text, '');
  lines.push(
    `## ${render(language, msg('report.section.environment'))}`, '',
    `- hangar: ${env.hangarVersion}`,
    `- Claude Code: ${env.claudeVersion ?? render(language, msg('report.env.unknown'))}`,
    `- OS: ${env.os}`,
    `- arch: ${env.arch}`,
    '',
    REPORT_MARKER,
    '',
  );
  return { title, body: lines.join('\n') };
}
