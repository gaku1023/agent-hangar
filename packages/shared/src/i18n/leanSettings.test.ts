import { describe, expect, it } from 'vitest';
import { en } from './en.ts';
import { ja } from './ja.ts';

/**
 * 設定とダイアログの補助ラベルを削った分（docs/plans/lean-labels.md の組 2）。
 * 配置、見出し、ボタンで足りる文と、同じ文の重複は辞書から消す。
 * 消した鍵が辞書に戻ってこないことを見る。
 */
const REMOVED = [
  'settings.cloud.off.note',
  'settings.cloud.legacy.status',
  'settings.tools.register.desc',
  'settings.summary.engine.off.desc',
  'settings.integrations.inject.hook.desc',
  'update.settings.notifyOn',
  'update.settings.notifyOff',
  'compat.status.okLead',
  'compat.status.okNote',
  'cloudMember.toast.sasNote',
  'cloudMember.join.startNote',
  'configSyncUi.awaiting.desc',
  'newSession.note.quick',
  'newSession.hint.quick',
  'newSession.newDir.gitInitNote',
  'newProject.gitInit.description',
  'newProject.candidates.suggestNote',
  'promote.dialog.lead',
  'promote.gitInit.description',
  'promote.move.description',
  'account.add.conflictNote',
];

describe('設定とダイアログで削った文', () => {
  it('消した鍵は、日本語と英語のどちらの辞書にも無い', () => {
    for (const k of REMOVED) {
      expect(ja as Record<string, string>, k).not.toHaveProperty(k);
      expect(en as Record<string, string>, k).not.toHaveProperty(k);
    }
  });
  it('「クローンして npm install したディレクトリで」は、設定のクラウド同期の節の頭の 1 か所だけで言う', () => {
    const shown = /^(settings|cloudUsage|cloudMember|configSyncUi)\./;
    const hits = Object.entries(ja as Record<string, string>).filter(([k, v]) => shown.test(k) && /clone|クローン/.test(v) && /npm install/.test(v)).map(([k]) => k);
    expect(hits).toEqual([]);
    expect(ja['settings.cloud.betaLead']).toContain('リポジトリのクローン');
  });
  it('言い直しを削った説明は、条件と例外だけを言う', () => {
    expect(ja['settings.general.language.desc']).toBe('ステータスは英語のままです');
    expect(ja['settings.general.terminal.desc']).toBe('iTerm2 は初回に macOS の自動化の許可を求めます。失敗したら Terminal.app で開きます');
    expect(ja['settings.general.retention.desc']).not.toContain('差分');
    expect(ja['settings.general.autoDone.desc']).not.toContain('✦');
    expect(ja['settings.editor.desc']).not.toContain('検出状況');
  });
});
