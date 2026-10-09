import { approveText, loggedOutText, type AccountGauge, type AccountView } from '../../presenters/accounts.ts';
import { useT } from './language.tsx';

/**
 * アカウント 1 つ分の、色の点・名前・プラン・メールと、5 時間と週の使用率の 2 本の棒。
 * 切り替えの開いた先と、新規セッションのダイアログの札で使い回す（どちらも押す札の中身で、押すのは外側）。
 * 押す部品の中に置くので、中身は phrasing content（span）だけで組む。
 * 棒は UsageGauge と同じ形（.gauge-bar と .gauge-fill）で、警告の印（data-high）は presenter が決めた high に従う。
 * showResets のときは、枠が戻る時刻を右に添える。
 * 値が 1 つも無ければ、棒の代わりに 1 行で言う。
 * 認証は、未ログインと初めてのログインの途中だけメールの行で言い、未読のときは空のままにする。
 * ログインし直しの途中（running で loggedIn が真）は、メールを消さずに出したまま、承認の添え書きを 1 行足す。
 */
export function AccountMeters(props: { account: AccountView; showResets: boolean }) {
  const a = props.account;
  const t = useT();
  const noValue = a.fiveHour === null && a.sevenDay === null;
  const again = a.auth === 'running' && a.loggedIn;
  return (
    <span className="account-meters">
      <span className="account-meters-head">
        <span className="st-dot" style={{ color: a.color }} aria-hidden="true" />
        <b className="account-meters-name">{a.name}</b>
        {a.plan !== null && <span className="account-plan">{a.plan}</span>}
      </span>
      <span className="account-mail mono" data-auth={a.auth}>{a.auth === 'out' ? loggedOutText(t) : a.auth === 'running' && !a.loggedIn ? approveText(t) : a.email ?? ''}</span>
      {again && <span className="account-approve">{approveText(t)}</span>}
      {noValue ? <span className="account-none">{t('account.meters.noValue')}</span> : (
        <>
          <Row name={a.name} label={t('account.meters.fiveHourLabel')} short={t('account.meters.fiveHourShort')} gauge={a.fiveHour} showResets={props.showResets} />
          <Row name={a.name} label={t('account.meters.weekLabel')} short={t('account.meters.weekShort')} gauge={a.sevenDay} showResets={props.showResets} />
        </>
      )}
      {a.note !== null && <span className="account-note" data-tone={a.note.tone}>{a.note.text}</span>}
    </span>
  );
}

function Row(props: { name: string; label: string; short: string; gauge: AccountGauge | null; showResets: boolean }) {
  const t = useT();
  const g = props.gauge;
  const pct = g === null ? 0 : Math.max(0, Math.min(100, g.percent));
  const high = g?.high === true;
  return (
    <span className="account-row">
      <span className="account-row-key">{props.short}</span>
      <span className="gauge-bar" role="meter" aria-label={`${props.name} ${props.label}`} aria-valuenow={g?.percent} aria-valuemin={0} aria-valuemax={100}>
        <span className="gauge-fill" data-high={high ? 'true' : undefined} style={{ width: `${pct}%` }} />
      </span>
      <span className="account-row-num mono" data-high={high ? 'true' : undefined}>{g === null ? '—' : `${Math.round(g.percent)}%`}</span>
      <span className="account-row-resets">{props.showResets && g?.resets ? t('account.meters.resetsAt', { time: g.resets }) : ''}</span>
    </span>
  );
}
