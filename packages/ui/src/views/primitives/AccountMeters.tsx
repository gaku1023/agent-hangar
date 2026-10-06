import type { AccountGauge, AccountView } from '../../presenters/accounts.ts';

/**
 * アカウント 1 つ分の、色の点・名前・プラン・メールと、5 時間と週の使用率の 2 本の棒。
 * 切り替えの開いた先と、新規セッションのダイアログの札で使い回す（どちらも押す札の中身で、押すのは外側）。
 * 押す部品の中に置くので、中身は phrasing content（span）だけで組む。
 * 棒は UsageGauge と同じ形（.gauge-bar と .gauge-fill）で、80% 以上は警告の印（data-high）を持つ。
 * showResets のときは、枠が戻る時刻を右に添える。
 * 値が 1 つも無ければ、棒の代わりに 1 行で言う。
 * 認証は、未ログインとログインの途中だけメールの行で言い、未読のときは空のままにする。
 */
export function AccountMeters(props: { account: AccountView; showResets: boolean }) {
  const a = props.account;
  const noValue = a.fiveHour === null && a.sevenDay === null;
  return (
    <span className="account-meters">
      <span className="account-meters-head">
        <span className="st-dot" style={{ color: a.color }} aria-hidden="true" />
        <b className="account-meters-name">{a.name}</b>
        {a.plan !== null && <span className="account-plan">{a.plan}</span>}
      </span>
      <span className="account-mail mono" data-auth={a.auth}>{a.auth === 'out' ? '未ログイン' : a.auth === 'running' ? 'ブラウザで承認してください…' : a.email ?? ''}</span>
      {noValue ? <span className="account-none">まだ値がありません</span> : (
        <>
          <Row name={a.name} label="5 時間枠の使用率" short="5 時間" gauge={a.fiveHour} showResets={props.showResets} />
          <Row name={a.name} label="週の枠の使用率" short="週" gauge={a.sevenDay} showResets={props.showResets} />
        </>
      )}
      {a.note !== null && <span className="account-note" data-tone={a.note.tone}>{a.note.text}</span>}
    </span>
  );
}

function Row(props: { name: string; label: string; short: string; gauge: AccountGauge | null; showResets: boolean }) {
  const g = props.gauge;
  const pct = g === null ? 0 : Math.max(0, Math.min(100, g.percent));
  return (
    <span className="account-row">
      <span className="account-row-key">{props.short}</span>
      <span className="gauge-bar" role="meter" aria-label={`${props.name} ${props.label}`} aria-valuenow={g?.percent} aria-valuemin={0} aria-valuemax={100}>
        <span className="gauge-fill" data-high={pct >= 80 ? 'true' : undefined} style={{ width: `${pct}%` }} />
      </span>
      <span className="account-row-num mono" data-high={pct >= 80 ? 'true' : undefined}>{g === null ? '—' : `${Math.round(g.percent)}%`}</span>
      <span className="account-row-resets">{props.showResets && g?.resets ? `${g.resets} に戻る` : ''}</span>
    </span>
  );
}
