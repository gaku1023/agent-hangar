import { describe, expect, it } from 'vitest';
import { translator, type SharePreviewDto } from '@agent-hangar/shared';
import { presentShare } from './share.ts';

const t = translator('ja');
const HOME = '/Users/me';
const PREVIEW: SharePreviewDto = {
  files: [{ path: '/Users/me/.claude/CLAUDE.md', scope: 'user', status: 'inline' }],
  mcp: [
    { name: 'files', source: 'user', transport: 'stdio' },
    { name: 'remote', source: 'user', transport: 'http' },
    { name: 'legacy', source: 'user', transport: 'sse', skipped: 'sse' },
    { name: 'dup', source: 'user', transport: 'stdio', skipped: 'conflict' },
    { name: 'needs', source: 'user', transport: 'stdio', skipped: 'missingEnv', envName: 'API_KEY' },
    { name: 'noenv', source: 'user', transport: 'stdio', skipped: 'missingEnv' },
  ],
};

describe('presentShare', () => {
  it('既定は指示が入、MCP が切。切の行は一覧を作らない', () => {
    const p = presentShare(t, 'codex', {}, PREVIEW, HOME);
    expect(p.instructions.on).toBe(true);
    expect(p.mcp.on).toBe(false);
    expect(p.mcp.list).toBeNull();
    expect(p.instructions.desc).toBe('起動時に CLAUDE.md の内容を Codex に渡します。Codex の設定ファイルは変更しません。');
  });
  it('答えが届く前は、入でも一覧を作らない', () => {
    expect(presentShare(t, 'codex', {}, undefined, HOME).instructions.list).toBeNull();
  });
  it('指示：ホームを ~ に縮め、Codex だけ長い指示の注記を添える', () => {
    const codex = presentShare(t, 'codex', {}, PREVIEW, HOME).instructions.list!;
    expect(codex.files).toEqual([{ path: '~/.claude/CLAUDE.md' }]);
    expect(codex.notes).toEqual(['作業ディレクトリの CLAUDE.md と CLAUDE.local.md は、セッションごとに読み込みます。', '長い指示はファイルのパスだけを渡し、Codex に読み込ませます。']);
    expect(presentShare(t, 'opencode', {}, PREVIEW, HOME).instructions.list!.notes).toHaveLength(1);
  });
  it('MCP：渡すものに札（コマンド、URL）、渡さないものに理由を付ける', () => {
    const list = presentShare(t, 'codex', { codexShareMcp: true }, PREVIEW, HOME).mcp.list!;
    expect(list.mcp).toEqual([{ name: 'files', kind: 'コマンド' }, { name: 'remote', kind: 'URL' }]);
    expect(list.skipped).toEqual([
      { name: 'legacy', reason: 'Codex は SSE 形式に対応していないため' },
      { name: 'dup', reason: 'Codex に同じ名前の登録があるため' },
      { name: 'needs', reason: '環境変数 API_KEY が設定されていないため' },
      { name: 'noenv', reason: '環境変数が設定されていないため' },
    ]);
  });
  it('何も無ければ「渡すものはありません。」', () => {
    const p = presentShare(t, 'opencode', { opencodeShareMcp: true }, { files: [], mcp: [] }, HOME);
    expect(p.instructions.list!.empty).toBe('渡すものはありません。');
    expect(p.mcp.list!.empty).toBe('渡すものはありません。');
  });
});
