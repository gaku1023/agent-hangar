import type { CompatState } from '@agent-hangar/shared';
import type { CompatProps } from '../presenters/compat.ts';
import { CopyButton } from './primitives/CommandLine.tsx';
import { Icon } from './primitives/Icon.tsx';

/**
 * ずれの中身（A4）。止めた機能は常に出し、契約、値、版、最初に見た時刻、止めた機能の表は「ずれ N 件の中身」で畳む。
 * 表の下に記録の置き場と「報告用に写す」を置く。設定の互換の節が使う。
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

/** 見出しの右端の札の調子。未確認の版は止めていないので、印の無い灰色にする。 */
const BADGE_TONE: Record<CompatState, 'ok' | 'info' | 'warn'> = { ok: 'ok', unverified: 'info', drift: 'warn' };

/**
 * 設定の「連携」の群の先頭の節（C2）。
 * MCP と statusline の節と同じく、見出しと右端の札で状態を言い、本文に手元の版と確かめた版を出す。
 * 未確認の版は版の並びに止めていないことを添え、ずれは前置きの下に止めた機能と畳んだ細目（CompatDrifts）を出す。
 * 準備の確かめが届く前は「確かめています」と出す。
 */
export function CompatSection(props: { compat: CompatProps | null }) {
  const c = props.compat;
  return (
    <section className="cp-sec">
      <h3 className="h2">
        Claude Code との互換
        {c && (
          <span className="badge" data-tone={BADGE_TONE[c.state]}>
            {c.state === 'ok' && <Icon name="check" />}
            {c.state === 'drift' && <Icon name="alert" />}
            {c.badge}
          </span>
        )}
      </h3>
      <div className="muted">hangar は Claude Code の会話の記録、状態のファイル、statusline、<code>~/.claude</code> の項目、CLI の出力、画面の文字を読んでいます。知らない形に出会ったら、ここに出します。</div>
      {c === null ? <div className="faint" style={{ marginTop: 4 }}>確かめています</div> : (
        <div className="cp-vers">
          <span>手元の版 <code>{c.localVersion}</code></span>
          <span>確かめた版 <code>{c.verifiedVersion}</code></span>
          {c.state === 'unverified' && <span className="faint">{c.lead}</span>}
        </div>
      )}
      {c !== null && c.state === 'drift' && (
        <>
          <div className="cp-lead">{`${c.lead}。`}</div>
          <CompatDrifts c={c} />
        </>
      )}
    </section>
  );
}
