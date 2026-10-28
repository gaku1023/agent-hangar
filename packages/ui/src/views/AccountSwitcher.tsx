import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useEmit } from '../action/chain.tsx';
import { isPickableAccount, switchLabel, type AccountView } from '../presenters/accounts.ts';
import type { HeaderAccountProps } from '../presenters/shell.ts';
import type { AgentUsageView } from '../presenters/accounts.ts';
import { AccountMeters, MeterRow } from './primitives/AccountMeters.tsx';
import { AgentIcon } from './primitives/AgentIcon.tsx';
import { Icon } from './primitives/Icon.tsx';
import { staggerIn } from './primitives/motionKit.ts';
import { useT } from './primitives/language.tsx';
import { place, type Placement } from './primitives/listboxModel.ts';
import { foldAt } from './headerFold.ts';

/** 開いた先の幅。 */
const WIDTH = 380;
/** 設定の画面の、アカウントの節への道。着くと、その節が見える位置へ移る。 */
const SETTINGS = { name: 'settings', at: 'accounts' } as const;

/**
 * ヘッダのアカウントの切り替え。
 * 色の点、名前、計器（children）、▾ の全体が 1 つのボタンで、押すとアカウントの一覧が開く。
 * アカウントが 1 件のときも同じ顔と同じ面にする。面の札でリセットの時刻が読め、下の段から 2 件目を足せる。
 * ヘッダは窓を掴む領域なので、押す部品はボタンにする。
 * 一覧はアカウントごとに 1 枚の札で、選ぶと、ホームなら「いまのアカウント」を、セッション画面ならそのセッションのアカウントを替える。
 * いまの札を押しても何も出さず、閉じるだけにする。未ログインの札と初めてのログインの途中の札は押せない（理由は札の中身が言う）。ログインし直しの途中の札は、いまのログインが生きているので押せる。
 * Codex の枠が届いていれば、面を Claude Code と Codex の節に分け、Codex の枠も並べる（顔は開いている会話のエージェントの枠だけを出すので、ほかの枠はここで見る）。
 * 開くたびに accounts.load を出し、認証を読み直させる。
 * 面は document.body への portal に描く（ヘッダの重なりに切られないため）。
 * 位置は place() で決め、Esc と外側の押下で閉じる。Esc ではボタンへフォーカスを戻す。
 */
export function AccountSwitcher(props: { account: NonNullable<HeaderAccountProps>; children: ReactNode }) {
  const { shown, list, sessionId, working, codex, codexAccounts } = props.account;
  // Claude の節でいまの札。Codex の会話の画面では顔が Codex のアカウントなので、Claude の節は別に持つ。
  const claudeShownId = codexAccounts?.claudeShownId ?? shown.id;
  const emit = useEmit();
  const t = useT();
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<Placement | null>(null);
  const face = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const popId = `${useId()}-accounts`;

  const show = () => { setPos(null); setOpen(true); emit({ type: 'accounts.load' }); };
  const hide = (refocus: boolean) => {
    setOpen(false);
    setPos(null);
    if (refocus) face.current?.focus();
  };

  const reposition = useCallback(() => {
    if (!face.current || !pop.current) return;
    const r = face.current.getBoundingClientRect();
    setPos(place({ top: r.top, bottom: r.bottom, left: r.left, width: r.width }, pop.current.offsetHeight, { width: window.innerWidth, height: window.innerHeight }, { minWidth: WIDTH, align: 'end' }));
  }, []);
  useLayoutEffect(() => { if (open) reposition(); }, [open, reposition]);

  // 位置が決まって見えてから、開くたびに一度だけ、shown の札へフォーカスを送り、節の見出しと札を上から順に浮かせる。
  const ready = open && pos !== null;
  useLayoutEffect(() => {
    if (!ready || !pop.current) return;
    (pop.current.querySelector<HTMLElement>('[role="menuitemradio"][data-face="true"]') ?? pop.current.querySelector<HTMLElement>('[role="menuitemradio"][aria-checked="true"]'))?.focus();
    staggerIn([...pop.current.querySelectorAll<HTMLElement>('.account-sec, .account-card')]);
  }, [ready]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (pop.current?.contains(t) || face.current?.contains(t)) return;
      hide(false);
    };
    document.addEventListener('mousedown', onDown);
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
    };
  }, [open, reposition]);

  // 選べない札（isPickableAccount）は、押しても切り替えられない。shown の札だけは、押すと閉じるので除く。
  const blocked = (a: AccountView) => !isPickableAccount(a) && a.id !== claudeShownId;
  const choose = (a: AccountView) => {
    if (blocked(a)) return;
    hide(true);
    if (a.id === claudeShownId) return;
    emit(sessionId === null ? { type: 'account.choose', accountId: a.id } : { type: 'account.switchSession', sessionId, accountId: a.id, working });
  };

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); hide(true); return; }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const cards = [...(pop.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"]') ?? [])];
    if (cards.length === 0) return;
    e.preventDefault();
    const at = cards.indexOf((e.target as HTMLElement).closest<HTMLElement>('[role="menuitemradio"]') as HTMLElement);
    const next = e.key === 'ArrowDown' ? at + 1 : at < 0 ? cards.length - 1 : at - 1;
    cards[(next + cards.length) % cards.length]!.focus();
  };

  // Codex の札。Codex の会話の画面なら、確認を挟んでその会話を別のアカウントで再開し、それ以外ではいまの Codex アカウントを替える。Claude 側は触らない。
  const chooseCodex = (a: AccountView) => {
    if (!codexAccounts) return;
    if (!isPickableAccount(a) && a.id !== codexAccounts.shownId) return;
    hide(true);
    if (a.id === codexAccounts.shownId) return;
    emit(codexAccounts.sessionId === null ? { type: 'account.choose', agent: 'codex', accountId: a.id } : { type: 'account.switchSession', agent: 'codex', sessionId: codexAccounts.sessionId, accountId: a.id, working: codexAccounts.working });
  };
  const codexMenu = codexAccounts && (
    <div role="menu" aria-label={t('accountSwitcher.menu.codexAria')} className="account-cards">
      {codexAccounts.list.map((a) => {
        const isShown = a.id === codexAccounts.shownId;
        // 承認待ち（初めてのログインの途中）の札は、中に押せる操作を持つので、ボタンではなく枠にする。
        if (a.auth === 'running' && !a.loggedIn) {
          return (
            <div key={a.id} className="account-card" aria-disabled="true" data-approval="true">
              <AccountMeters account={a} showResets />
              <span className="account-card-acts">
                {a.login?.method !== 'deviceCode' && <button type="button" className="account-card-act" onClick={() => emit({ type: 'account.login', agent: 'codex', accountId: a.id, method: 'deviceCode' })}>{t('account.login.deviceCodeButton')}</button>}
                <button type="button" className="account-card-act" data-quiet="true" onClick={() => emit({ type: 'account.login.cancel', agent: 'codex', accountId: a.id })}>{t('account.settings.cancel')}</button>
              </span>
            </div>
          );
        }
        const disabled = !isPickableAccount(a) && !isShown;
        return (
          <button key={a.id} type="button" role="menuitemradio" aria-checked={isShown} data-face={isShown && codexAccounts.sessionId !== null ? 'true' : undefined} aria-disabled={disabled ? 'true' : undefined} className="account-card" onClick={() => chooseCodex(a)}>
            <AccountMeters account={a} showResets />
          </button>
        );
      })}
    </div>
  );
  const sectionAdd = (agent: 'claude' | 'codex') => (
    <button type="button" className="account-sec-add" aria-label={t(agent === 'codex' ? 'accountSwitcher.add.codex' : 'accountSwitcher.add.claude')} onClick={() => { hide(true); emit(agent === 'codex' ? { type: 'account.add.open', agent: 'codex' } : { type: 'account.add.open' }); }}><Icon name="add" /></button>
  );

  const claudeMenu = (
    <div role="menu" aria-label={t('accountSwitcher.menu.aria')} className="account-cards">
      {list.map((a) => {
        const isShown = a.id === claudeShownId;
        const disabled = blocked(a);
        return (
          <button key={a.id} type="button" role="menuitemradio" aria-checked={isShown} data-face={isShown && codexAccounts?.sessionId == null ? 'true' : undefined} aria-disabled={disabled ? 'true' : undefined} className="account-card" onClick={() => choose(a)}>
            {/* 右上に一言（「現在のアカウント」「切り替える」）は置かない（2026-10-27 の利用者の決定）。いまの札は青い輪で、押せない理由は札の中身（メールの行）が言う。 */}
            <AccountMeters account={a} showResets />
          </button>
        );
      })}
    </div>
  );

  return (
    <>
      <button ref={face} type="button" className="account-switch" aria-label={switchLabel(t, shown)} aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? popId : undefined}
        onClick={() => (open ? hide(false) : show())}>
        <span className="st-dot account-dot" style={{ color: shown.color }} aria-hidden="true" />
        <span className="account-name" data-fold-at={foldAt('account-name')}>{shown.name}</span>
        {props.children}
        <span className="account-caret" aria-hidden="true">▾</span>
      </button>
      {open && createPortal(
        <div ref={pop} id={popId} role="dialog" aria-label={t('accountSwitcher.dialog.aria')} tabIndex={-1} className="menu-pop account-pop" data-up={pos?.up ? 'true' : undefined} onKeyDown={onKey}
          style={pos ? { left: pos.left, width: pos.width, top: pos.top, bottom: pos.bottom } : { visibility: 'hidden', left: 0, top: 0, width: WIDTH }}>
          {/* Codex の枠が届いていれば、Claude Code と Codex の見出しで節を分ける（試作 usage-pop-proto の B）。届いていなければ、見出しを出さず Claude の札だけにする。 */}
          {codexAccounts ? (
            <div className="account-cards">
              <div role="group" aria-labelledby={`${popId}-claude`} className="account-group">
                <div className="account-sec"><AgentIcon kind="claude-code" decorative /><span id={`${popId}-claude`}>{t('accountSwitcher.section.claude')}</span>{list.length > 1 && <span className="account-sec-hint">{t('accountSwitcher.section.claudeHint')}</span>}{sectionAdd('claude')}</div>
                {claudeMenu}
              </div>
              <div role="group" aria-labelledby={`${popId}-codex`} className="account-group">
                <div className="account-sec"><AgentIcon kind="codex" decorative /><span id={`${popId}-codex`}>{t('accountSwitcher.section.codex')}</span>{codexAccounts.list.length > 1 && <span className="account-sec-hint">{t('accountSwitcher.section.claudeHint')}</span>}{sectionAdd('codex')}</div>
                {codexMenu}
              </div>
            </div>
          ) : codex ? (
            <div className="account-cards">
              <div role="group" aria-labelledby={`${popId}-claude`} className="account-group">
                <div className="account-sec"><AgentIcon kind="claude-code" decorative /><span id={`${popId}-claude`}>{t('accountSwitcher.section.claude')}</span>{list.length > 1 && <span className="account-sec-hint">{t('accountSwitcher.section.claudeHint')}</span>}</div>
                {claudeMenu}
              </div>
              <div role="group" aria-labelledby={`${popId}-codex`} className="account-group">
                <div className="account-sec"><AgentIcon kind="codex" decorative /><span id={`${popId}-codex`}>{t('accountSwitcher.section.codex')}</span></div>
                <CodexCard usage={codex.usage} here={codex.here} />
              </div>
            </div>
          ) : claudeMenu}
          {/* 下の段は、左に「アカウントを追加」、右に「アカウントの設定」（試作の 1A）。追加は設定の画面にある「アカウントを足す」のダイアログを直接開く。
              Codex のアカウントが届いているときは、追加は節の見出しの「＋」に移り、下の段は「アカウントの設定」だけにする。 */}
          <div className="account-pop-foot" data-solo={codexAccounts ? 'true' : undefined}>
            {!codexAccounts && <button type="button" className="account-add" onClick={() => { hide(true); emit({ type: 'account.add.open' }); }}><Icon name="add" />{t('accountSwitcher.footer.add')}</button>}
            <button type="button" className="account-settings" onClick={() => { hide(true); emit({ type: 'nav.go', to: SETTINGS }); }}>{t('accountSwitcher.footer.settings')}</button>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}

/**
 * 面の Codex の節の札。Codex にはアカウントの切り替えが無いので、押せる札（ボタン）にしない。
 * 中身は Claude の札（AccountMeters）と同じ格子で、名前の行、最終更新の行、5 時間と週の行。Codex の会話を開いているときだけ、右上に「このセッション」と出す。
 */
function CodexCard(props: { usage: AgentUsageView; here: boolean }) {
  const t = useT();
  const u = props.usage;
  const name = t('accountSwitcher.codex.name');
  return (
    <div className="account-card" data-info="true" data-here={props.here ? 'true' : undefined}>
      {props.here && <span className="account-card-tag" data-kind="here">{t('accountSwitcher.tag.codexSession')}</span>}
      <span className="account-meters">
        <span className="account-meters-head">
          <b className="account-meters-name">{name}</b>
          {u.plan !== null && <span className="account-plan">{u.plan}</span>}
        </span>
        <span className="account-mail">{u.updatedLabel === null ? '' : t('accountSwitcher.codex.updated', { time: u.updatedLabel })}</span>
        {u.fiveHour === null && u.sevenDay === null ? <span className="account-none">{t('account.meters.noValue')}</span> : (
          <>
            <MeterRow name={name} label={t('account.meters.fiveHourLabel')} short={t('account.meters.fiveHourShort')} gauge={u.fiveHour} showResets />
            <MeterRow name={name} label={t('account.meters.weekLabel')} short={t('account.meters.weekShort')} gauge={u.sevenDay} showResets />
          </>
        )}
      </span>
    </div>
  );
}
