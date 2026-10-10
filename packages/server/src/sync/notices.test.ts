import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { memoLossHandlers, sessionMemoBackupMessage, toastVia } from './notices.ts';

describe('セッションのメモの控えの知らせ', () => {
  it('どの端末に負けて、どこに残したかを言う', () => {
    // 控えはもうファイルになっている。知らせが無いと、利用者は消えたようにしか見えない。
    const m = sessionMemoBackupMessage({ sessionId: 's1', markdown: '手元のメモ', deviceName: 'mini', backupFile: '/tmp/backups/memos/session-s1-20260919-101112.md' });
    expect(m).toContain('mini');
    expect(m).toContain('/tmp/backups/memos/session-s1-20260919-101112.md');
    // 本文そのものはトーストに出さない（メモは長い文章になりうる）。
    expect(m).not.toContain('手元のメモ');
  });
});

describe('メモで負けたときの後始末', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-notices-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  const setup = () => {
    const toasts: { level: string; message: string }[] = [];
    let pruned = 0;
    const h = memoLossHandlers({
      memoPath: (projectId) => path.join(dir, 'projects', projectId, 'memo.md'),
      toast: (level, message) => { toasts.push({ level, message }); },
      pruneMemos: () => { pruned++; },
      language: () => 'ja',
    });
    return { h, toasts, pruned: () => pruned };
  };

  it('プロジェクトのメモは、負けた手元の内容をメモの隣に残し、残したファイルの名前を知らせる', () => {
    const { h, toasts, pruned } = setup();
    h.onMemoConflict({ projectId: 'p1', markdown: '手元の文章', deviceName: 'mini' });
    const files = fs.readdirSync(path.join(dir, 'projects', 'p1'));
    expect(files.length).toBe(1);
    expect(files[0]).toMatch(/^memo\.conflict-mini-/);
    expect(fs.readFileSync(path.join(dir, 'projects', 'p1', files[0]!), 'utf8')).toBe('手元の文章');
    expect(toasts).toEqual([{ level: 'info', message: `ノートが競合しました。手元の内容を ${files[0]} に残しました` }]);
    // 写しはメモの隣に置く。控えの世代には数えないので、刈らない。
    expect(pruned()).toBe(0);
  });

  it('セッションのメモは、置き場を知らせてから控えの世代を刈る', () => {
    const { h, toasts, pruned } = setup();
    h.onSessionMemoBackup({ sessionId: 's1', markdown: 'x', deviceName: 'mini', backupFile: '/b/session-s1.md' });
    expect(toasts.length).toBe(1);
    expect(toasts[0]!.level).toBe('info');
    expect(toasts[0]!.message).toContain('/b/session-s1.md');
    expect(pruned()).toBe(1);
  });

  it('トーストは配る層を通る', () => {
    const sent: unknown[] = [];
    toastVia({ broadcast: (ev) => { sent.push(ev); } })('error', 'だめでした');
    expect(sent).toEqual([{ type: 'toast', level: 'error', message: 'だめでした' }]);
  });
});
