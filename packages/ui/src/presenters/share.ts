import { codexShareOf, opencodeShareOf, type SharePreviewAgent, type SharePreviewDto, type ShareSkipReasonDto, type Translate } from '@agent-hangar/shared';
import { homePath } from '../lib/paths.ts';

/**
 * 設定の Codex・opencode の節にある「Claude Code の指示を渡す」「Claude Code の MCP を渡す」の 2 行（案 B）。
 * 一覧（list）は、スイッチが入で、サーバの答え（GET /api/share/preview）が届いているときだけ作る。届く前と切のときは null で、画面は箱を出さない。
 */
export type ShareListProps = {
  /** 渡すものが 1 件も、渡さないものも無いときの文。それ以外は null。 */
  empty: string | null;
  /** 渡す指示のファイル（ホームを ~ に縮めた表示）。 */
  files: { path: string }[];
  /** 渡す MCP。kind は札の文字（コマンド、URL）。 */
  mcp: { name: string; kind: string }[];
  /** 渡さないもの（指示のファイルも MCP も）。reason は理由の文。 */
  skipped: { name: string; reason: string }[];
  /** 一覧の下に添える注記。 */
  notes: string[];
};
export type ShareRowProps = { on: boolean; desc: string; list: ShareListProps | null };
export type ShareSettingsProps = { agent: SharePreviewAgent; instructions: ShareRowProps; mcp: ShareRowProps };

const AGENT_NAME = { codex: 'Codex', opencode: 'opencode' } as const;

function reasonText(t: Translate, agent: SharePreviewAgent, reason: ShareSkipReasonDto, envName: string | undefined): string {
  const name = AGENT_NAME[agent];
  switch (reason) {
    case 'agentsMd': return t('settings.share.skip.agentsMd');
    case 'conflict': return t('settings.share.skip.conflict', { agent: name });
    case 'sse': return t('settings.share.skip.sse', { agent: name });
    case 'missingEnv': return envName ? t('settings.share.skip.missingEnv', { name: envName }) : t('settings.share.skip.missingEnvAny');
    case 'disabled': return t('settings.share.skip.disabled');
    case 'unapproved': return t('settings.share.skip.unapproved');
    case 'invalid': return t('settings.share.skip.invalid');
    case 'reserved': return t('settings.share.skip.reserved');
  }
}

export function presentShare(t: Translate, agent: SharePreviewAgent, settings: Parameters<typeof codexShareOf>[0] & Parameters<typeof opencodeShareOf>[0], preview: SharePreviewDto | undefined, home: string | null | undefined): ShareSettingsProps {
  const on = agent === 'codex' ? codexShareOf(settings) : opencodeShareOf(settings);
  const name = AGENT_NAME[agent];
  const row = (flag: boolean, descKey: 'settings.share.instructions.desc' | 'settings.share.mcp.desc', list: ShareListProps | null): ShareRowProps => ({
    on: flag, desc: t(descKey, { agent: name }), list: flag ? list : null,
  });

  let instructions: ShareListProps | null = null;
  let mcp: ShareListProps | null = null;
  if (preview) {
    // 本文を渡す、場所だけ渡す、Codex が自分で読む、はどれも「渡す」側に並べる。AGENTS.md を優先するものと、読めないものは渡さない側に出す。
    const given = preview.files.filter((f) => f.status !== 'agentsMd' && f.status !== 'unreadable');
    const notGiven = preview.files.filter((f) => f.status === 'agentsMd');
    instructions = {
      empty: given.length === 0 && notGiven.length === 0 ? t('settings.share.empty') : null,
      files: given.map((f) => ({ path: homePath(f.path, home) })),
      mcp: [],
      skipped: notGiven.map((f) => ({ name: homePath(f.path, home), reason: t('settings.share.skip.agentsMd') })),
      notes: [t('settings.share.note.folder'), ...(agent === 'codex' ? [t('settings.share.note.long')] : [])],
    };
    const passed = preview.mcp.filter((m) => !m.skipped);
    const skipped = preview.mcp.filter((m) => m.skipped);
    mcp = {
      empty: preview.mcp.length === 0 ? t('settings.share.empty') : null,
      files: [],
      mcp: passed.map((m) => ({ name: m.name, kind: t(m.transport === 'stdio' ? 'settings.share.command' : 'settings.share.url') })),
      skipped: skipped.map((m) => ({ name: m.name, reason: reasonText(t, agent, m.skipped as ShareSkipReasonDto, m.envName) })),
      notes: [],
    };
  }
  return { agent, instructions: row(on.instructions, 'settings.share.instructions.desc', instructions), mcp: row(on.mcp, 'settings.share.mcp.desc', mcp) };
}
