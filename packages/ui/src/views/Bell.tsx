import { useEmit } from '../action/chain.tsx';
import type { NoticeRow, NoticesProps } from '../presenters/notices.ts';
import { NoticeList } from './NoticeList.tsx';
import { Icon } from './primitives/Icon.tsx';
import { useT } from './primitives/language.tsx';
import { Popover } from './primitives/Popover.tsx';

/** 数の札は 2 桁まで。3 桁になったら「99+」にして、ヘッダーの幅を動かさない。 */
const countLabel = (n: number): string => (n > 99 ? '99+' : String(n));

/**
 * ヘッダーの「注意」（もとのベル）。押すと一覧が開く。数の札は未読の数で、0 なら出さない。
 * 中身（行）が 1 つも無ければ、注意そのものを描かない。ふだんは無く、出たら直すものだと形で伝える（2026-10-13 の決定、試作の 9a の A）。
 * 印は注意の三角で、数の札は Paused と同じ黄土にする。赤茶は入力待ち（今すぐの用）の色なので、急ぎでない注意には使わない。
 * 一覧は Popover（非モーダルの dialog）に置く。Enter か Space（ボタンなので）で開き、Esc で閉じて焦点をベルへ戻す。
 * 開いているかは View の中に持つ（Mediator は読まない）。開いただけでは既読にしない。
 * 既読にするのは、行の操作を押したときと「すべて既読にする」だけである。どちらも鍵を UiAction で送り、保存は Mediator が受ける（mediator/notices.ts）。
 */
export function Bell(props: NoticesProps & { /** 開いた形で描く（試験用の頁が撮るときだけ使う）。 */ defaultOpen?: boolean }) {
  const t = useT();
  const emit = useEmit();
  if (props.rows.length === 0) return null;
  return (
    <Popover label={t('notices.list.title')} width={400} align="end" className="notices-pop" defaultOpen={props.defaultOpen}
      face={(p) => (
        <button type="button" className="bell" data-tone="warn" aria-label={props.label} title={t('notices.list.title')} {...p}>
          <Icon name="warning" />
          {props.unread > 0 && <span className="bell-n" aria-hidden="true">{countLabel(props.unread)}</span>}
        </button>
      )}>
      {({ close }) => {
        // 行の操作は、未読なら既読にしてから、行き先へ移り、一覧を閉じる。
        const act = (row: NoticeRow) => {
          if (row.unread) emit({ type: 'notices.read', keys: [row.key] });
          emit(row.action.send);
          close();
        };
        return (
          <>
            <div className="pop-h">
              <span>{t('notices.list.title')}</span>
              <span className="faint notices-lead">{t('notices.list.lead')}</span>
              <button type="button" className="btn btn-ghost btn-sm end" disabled={props.unread === 0} onClick={() => emit({ type: 'notices.read', keys: props.keys })}>{t('notices.list.markAllRead')}</button>
            </div>
            <NoticeList rows={props.rows} onAct={act} />
          </>
        );
      }}
    </Popover>
  );
}
