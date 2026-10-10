import { useEmit } from '../action/chain.tsx';
import type { NoticeRow, NoticesProps } from '../presenters/notices.ts';
import { NoticeList } from './NoticeList.tsx';
import { Icon } from './primitives/Icon.tsx';
import { useT } from './primitives/language.tsx';
import { Popover } from './primitives/Popover.tsx';

/** 数の札は 2 桁まで。3 桁になったら「99+」にして、ヘッダーの幅を動かさない。 */
const countLabel = (n: number): string => (n > 99 ? '99+' : String(n));

/**
 * ヘッダーのベル。押すと知らせの一覧が開く。数の札は未読の数で、0 なら出さない。
 * 一覧は Popover（非モーダルの dialog）に置く。Enter か Space（ボタンなので）で開き、Esc で閉じて焦点をベルへ戻す。
 * 開いているかは View の中に持つ（Mediator は読まない）。開いただけでは既読にしない。
 * 既読にするのは、行の操作を押したときと「すべて既読にする」だけである。どちらも鍵を UiAction で送り、保存は Mediator が受ける（mediator/notices.ts）。
 * いまはどの画面にも付けていない。ヘッダーに置くのは別の変更である。
 */
export function Bell(props: NoticesProps & { /** 開いた形で描く（試験用の頁が撮るときだけ使う）。 */ defaultOpen?: boolean }) {
  const t = useT();
  const emit = useEmit();
  return (
    <Popover label={t('notices.list.title')} width={400} align="end" className="notices-pop" defaultOpen={props.defaultOpen}
      face={(p) => (
        <button type="button" className="bell" aria-label={props.label} title={t('notices.list.title')} {...p}>
          <Icon name="bell" />
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
              <span className="faint">{props.rows.length}</span>
              <button type="button" className="btn btn-ghost btn-sm end" disabled={props.unread === 0} onClick={() => emit({ type: 'notices.read', keys: props.keys })}>{t('notices.list.markAllRead')}</button>
            </div>
            {props.rows.length === 0 ? <p className="notices-empty faint">{t('notices.list.empty')}</p> : <NoticeList rows={props.rows} onAct={act} />}
          </>
        );
      }}
    </Popover>
  );
}
