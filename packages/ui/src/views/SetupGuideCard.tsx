import { useEmit } from '../action/chain.tsx';
import { useCopy } from './primitives/CommandLine.tsx';
import { useT } from './primitives/language.tsx';

/**
 * 設定の連携の末尾の札「Claude Code に環境を見てもらう」（試作の案 A と C の札）。
 * 貼る一言を等幅の枠でそのまま見せ、右の主ボタンでコピーする。写せたら COPIED_MS（1.6 秒）「コピーしました」にする。
 * コピーは書き込みではないので、ブラウザで開いた画面でも押せる。
 * 「手引きの中身を見る」は写した md を設定のエディタで開く（エディタが無ければ、ほかの「<名前> で開く」と同じ面が出る）。
 */
export function SetupGuideCard(props: { prompt: string; version: string }) {
  const t = useT();
  const emit = useEmit();
  const { copied, press } = useCopy(props.prompt);
  return (
    <section className="setup-guide">
      <h3 className="h2">{t('settings.integrations.guide.title')}<span className="badge" data-tone="off">v{props.version}</span></h3>
      <div className="muted">{t('settings.integrations.guide.desc')}</div>
      <div className="guide-prompt">
        <code>{props.prompt}</code>
        <button type="button" className="btn btn-primary" data-copied={copied ? 'true' : undefined} onClick={press}>{copied ? t('common.button.copied') : t('common.button.copy')}</button>
      </div>
      <div className="faint guide-foot">
        <span>{t('settings.integrations.guide.note')}</span>
        <button type="button" className="linkish" onClick={() => emit({ type: 'setupGuide.openEditor' })}>{t('settings.integrations.guide.open')}</button>
      </div>
    </section>
  );
}
