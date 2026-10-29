import { isNoticeOp, type InvestigateContext } from '@agent-hangar/shared';
import { useEmit } from '../action/chain.tsx';
import { Icon } from './primitives/Icon.tsx';
import { useT } from './primitives/language.tsx';

/**
 * エラーの札の「エージェントで調査…」（TODO 01a185d6）。エラーの事情を入れたクイックセッションのダイアログを開く。すぐには起動しない。
 * 形は「修復…」と同じ従のボタン。その場で直す口の無い注意（互換のずれ、エージェントの版、クラウドの古い形式）の見出しの右にも置く。
 * link は修復のダイアログの足の左に置く文字のボタン（試作の G）。
 */
export function InvestigateButton(props: { ctx: InvestigateContext; link?: boolean }) {
  const emit = useEmit();
  const t = useT();
  const open = () => emit({ type: 'investigate.open', ...props.ctx });
  // 注意（エラーではないもの）から開くときは、title も注意の言い方にする。
  const title = t(isNoticeOp(props.ctx.op) ? 'newSession.investigate.titleNotice' : 'newSession.investigate.title');
  if (props.link) return <button type="button" className="linkish investigate-link" title={title} onClick={open}><Icon name="search" />{t('newSession.investigate.button')}</button>;
  return <button type="button" className="btn btn-sm" title={title} onClick={open}>{t('newSession.investigate.button')}</button>;
}
