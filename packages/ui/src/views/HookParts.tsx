import { useContext, useEffect, useRef, useState } from 'react';
import type { EventRepoHookDto } from '@agent-hangar/shared';
import { EventHookApiContext } from './eventHookApi.ts';
import { Icon } from './primitives/Icon.tsx';
import { useT } from './primitives/language.tsx';
import { useCopy } from './primitives/CommandLine.tsx';

/**
 * 予定の画面の webhook の部品（#563）。
 * 外の webhook の URL のカード（D1）と、GitHub の repo の札（D3）と、最初の結び付けの手順（D4）。
 */

/**
 * 隠している間の URL の代わり。
 * 長さは本物の URL と関係を持たせない。
 */
const MASK = '••••••••••••••••••••';
/** 新しい URL を光らせておく長さ。 */
const GLOW_MS = 1800;

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * 外の webhook の URL のカード。
 * URL は秘密を含むので、表示かコピーを押したときだけ読み、この部品の state にだけ置く。
 * ストアにも UiAction にも通さない（コピーはクリップボードの道だけ）。
 * 行を閉じる（この部品が外れる）か、隠すを押すと捨てる。
 */
export function HookUrlCard(props: { id: string }) {
  const api = useContext(EventHookApiContext);
  const t = useT();
  const [url, setUrl] = useState<string | null>(null);
  const [shown, setShown] = useState(false);
  const [fresh, setFresh] = useState(false);
  const [ask, setAsk] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { copied, press } = useCopy(url ?? '');
  const alive = useRef(true);
  const copyWhenLoaded = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  // 光らせるのは一度だけ。
  useEffect(() => {
    if (!fresh) return;
    const id = setTimeout(() => setFresh(false), GLOW_MS);
    return () => clearTimeout(id);
  }, [fresh]);
  // 隠したままのコピーは、読み終えてからこの部品の URL で写す（press は描き直した後の URL を見る）。
  useEffect(() => {
    if (url && copyWhenLoaded.current) { copyWhenLoaded.current = false; press(); }
  }, [url, press]);
  if (!api) return null;

  /**
   * URL を読んで置く。
   * 読めなければ理由を出して null。
   */
  const load = async (): Promise<string | null> => {
    try {
      const u = await api.hookUrl(props.id);
      if (!alive.current) return null;
      setError(null);
      setUrl(u);
      return u;
    } catch (e) {
      if (alive.current) setError(messageOf(e));
      return null;
    }
  };
  const toggle = async () => {
    if (shown) { setShown(false); setUrl(null); return; }
    if (url || (await load())) setShown(true);
  };
  const copy = async () => {
    if (url) { press(); return; }
    copyWhenLoaded.current = true;
    if (!(await load())) copyWhenLoaded.current = false;
  };
  const rotate = async () => {
    setBusy(true);
    try {
      const failed = await api.rotateUrl(props.id);
      if (!alive.current) return;
      setAsk(false);
      if (failed) { setError(failed.message || t('schedules.event.hookFailed')); return; }
      setUrl(null);
      if (await load()) { setShown(true); setFresh(true); }
    } catch (e) {
      if (alive.current) { setAsk(false); setError(messageOf(e)); }
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  return (
    <div className="sch-hook-card">
      <div className="sch-url" data-fresh={fresh ? 'true' : undefined}><span>{shown && url ? url : MASK}</span></div>
      <div className="sch-acts">
        <button type="button" className="btn" onClick={() => void toggle()}>{t(shown ? 'schedules.event.url.hide' : 'schedules.event.url.show')}</button>
        <button type="button" className="btn" data-copied={copied ? 'true' : undefined} onClick={() => void copy()}>{copied ? t('common.button.copied') : t('common.button.copy')}</button>
        <span className="spacer" />
        {ask
          ? (
            <div className="sch-ask">
              <span className="faint">{t('schedules.event.url.rotateAsk')}</span>
              <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => setAsk(false)}>{t('common.button.cancel')}</button>
              <button type="button" className="btn btn-danger-fill" disabled={busy} onClick={() => void rotate()}>{t('schedules.event.url.rotate')}</button>
            </div>
          )
          : <button type="button" className="btn" onClick={() => setAsk(true)}>{t('schedules.event.url.rotate')}</button>}
      </div>
      {error && <div className="sch-ev-error" role="alert">{error}</div>}
    </div>
  );
}

const CHIP_KEY = { registered: 'schedules.event.hook.registered', no_admin: 'schedules.event.hook.noAccess', failed: 'schedules.event.hook.failed' } as const;

/**
 * repo の webhook の札。
 * 権限なしには、必要な権限の吹き出しを付ける。
 */
export function HookChip(props: { status: 'registered' | 'no_admin' | 'failed' }) {
  const t = useT();
  return <span className="sch-hook-chip" data-state={props.status} title={props.status === 'no_admin' ? t('schedules.event.noAdmin') : undefined}>{t(CHIP_KEY[props.status])}</span>;
}

/**
 * GitHub の repo の札。
 * 表示したときと、rev が進むたび（一覧の読み直しや操作が済むたび）に状態を取り直す。
 * 再試行は onRetry を渡された行だけが持つ。
 * 失敗の札には決めた一文を添える。
 * none（まだ何も無い）と読めなかったときは何も出さない。
 */
export function RepoHookChip(props: { repo: string; rev: number; onRetry?: () => void }) {
  const api = useContext(EventHookApiContext);
  const t = useT();
  const [state, setState] = useState<EventRepoHookDto | null>(null);
  const [waiting, setWaiting] = useState(false);
  useEffect(() => {
    if (!api) return;
    let live = true;
    api.repoHook(props.repo).then((s) => { if (live) { setState(s); setWaiting(false); } }, () => { if (live) setWaiting(false); });
    return () => { live = false; };
  }, [api, props.repo, props.rev]);
  if (!api || !state || state.status === 'none') return null;
  const failed = state.status === 'failed';
  return (
    <div className="sch-hook">
      <HookChip status={state.status} />
      {failed && <span className="sch-hook-note">{t('schedules.event.hookFailed')}</span>}
      {failed && props.onRetry && <button type="button" className="btn" disabled={waiting} onClick={() => { setWaiting(true); props.onRetry!(); }}>{t('schedules.event.hook.retry')}</button>}
    </div>
  );
}

/**
 * 最初の結び付けの手順。
 * 送っている間は設定、webhook と進み、済んだら待機に着いて登録済みの札を出す。
 */
export function HookSteps(props: { stage: 'setup' | 'webhook' | 'settled' }) {
  const t = useT();
  const order = ['setup', 'webhook', 'waiting'] as const;
  const at = props.stage === 'setup' ? 0 : props.stage === 'webhook' ? 1 : 2;
  return (
    <div className="sch-steps-row">
      <ol className="sch-steps" data-stage={props.stage} aria-live="polite">
        {order.map((s, i) => {
          const st = i < at ? 'done' : i === at ? 'active' : 'todo';
          return (
            <li key={s} className="sch-step" data-state={st}>
              <span className="sch-step-mark" aria-hidden="true">{st === 'done' ? <Icon name="check" /> : null}</span>
              <span>{t(`schedules.event.steps.${s}` as 'schedules.event.steps.setup')}</span>
            </li>
          );
        })}
      </ol>
      {props.stage === 'settled' && <HookChip status="registered" />}
    </div>
  );
}
