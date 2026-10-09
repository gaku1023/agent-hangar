import type { CompatProps } from '../presenters/compat.ts';
import { CopyButton } from './primitives/CommandLine.tsx';
import { Icon } from './primitives/Icon.tsx';

/**
 * ずれの中身（A4）。止めた機能は常に出し、契約、値、版、最初に見た時刻、止めた機能の表は「ずれ N 件の中身」で畳む。
 * 表の下に記録の置き場と「報告用に写す」を置く。設定の互換の節と、初回の確認リストの 6 行目が使う。
 * 開いているかどうかは画面の中だけの見え方なので、details に任せて Mediator には置かない。
 * 中身が届く前（rows が null）は何も出さない。
 */
export function CompatDrifts(props: { c: CompatProps }) {
  const c = props.c;
  if (c.state !== 'drift' || c.rows === null) return null;
  return (
    <>
      {c.stops && c.stops.length > 0 && (
        <ul className="cp-stops" aria-label="止めた機能">
          {c.stops.map((s) => <li key={s}>{s}</li>)}
        </ul>
      )}
      <details className="cp-more">
        <summary><Icon name="chevron" />{`ずれ ${c.count} 件の中身`}</summary>
        <div className="cp-more-body">
          <table className="cp-tab">
            <colgroup><col className="c-k" /><col /><col className="c-v" /><col className="c-t" /><col className="c-f" /></colgroup>
            <thead><tr><th>契約</th><th>値</th><th>版</th><th>最初に見た</th><th>止めた機能</th></tr></thead>
            <tbody>
              {c.rows.map((r) => (
                <tr key={r.key}>
                  <td>{r.contract}</td>
                  <td><code>{r.value}</code></td>
                  <td className="cp-n">{r.version}</td>
                  <td className="cp-n">{r.firstSeen}</td>
                  <td>{r.stop ?? <span className="faint">なし</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="cp-foot">
            <span className="faint">記録はこの PC の <code>~/.agent-hangar/compat.json</code> にあります</span>
            {c.report && <CopyButton text={c.report} ariaLabel="報告用に写す" label="報告用に写す" />}
          </div>
        </div>
      </details>
    </>
  );
}
