import type { NoticeRow } from '../presenters/notices.ts';
import { Icon } from './primitives/Icon.tsx';
import { useT } from './primitives/language.tsx';

/**
 * 知らせの行の並び（ヘッダーのベルの一覧の中身）。
 * 行は Presenter が事実から組んだもので、ここは描くだけである。文は props に入っているので、辞書は未読の読み上げにしか引かない。
 * 種類の印と名前は左の列、題と説明と操作は真ん中、時は右に置く。色の意味は data-tone に持つ（notices.css）。
 * 未読の行には data-unread と小さい点を付け、読み上げには「未読」を足す（色と点だけに頼らない）。
 * 操作を押したときの扱い（既読にする、移る、一覧を閉じる）は呼び手が決める（Bell.tsx）。
 */
export function NoticeList(props: { rows: NoticeRow[]; onAct: (row: NoticeRow) => void }) {
  const t = useT();
  return (
    <ul className="notices">
      {props.rows.map((r) => (
        <li key={r.key} className="prow" data-unread={r.unread ? '' : undefined}>
          <span className="n-kind" data-tone={r.tone}><Icon name={r.icon} />{r.kindLabel}</span>
          <div className="p-body">
            {/* 読み上げ用の「未読」は題の外に置く。題は行数で切るので、中に入れると見えない語のせいで省略記号が付く。 */}
            {r.unread && <span className="sr-only">{t('notices.row.unread')}</span>}
            <div className="p-t">{r.title}</div>
            {r.detail !== null && <div className="p-d">{r.detail}</div>}
            <div className="p-acts"><button type="button" className="btn btn-sm" onClick={() => props.onAct(r)}>{r.action.label}</button></div>
          </div>
          {r.when !== null && <span className="p-when">{r.when}</span>}
        </li>
      ))}
    </ul>
  );
}
