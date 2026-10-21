import { PHONE_MAX_AGE_MS, PUSH_QUIET_DEFAULT, type MobileAccount } from '@agent-hangar/shared/src/mobile.ts';
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { LeaveError, leavePhone } from '../api.ts';
import type { InboxView } from '../inbox.ts';
import {
  clearLaunchDefaults,
  DEFAULT_LABEL,
  EFFORT_OPTIONS,
  loadLaunchDefaults,
  MODEL_OPTIONS,
  PERMISSION_OPTIONS,
  permissionName,
  saveLaunchDefaults,
  type LaunchDefaults,
} from '../launchDefaults.ts';
import { usePresence, useSheetPhase } from '../presence.ts';
import { pushQuiet, readPushStatus, setPushQuiet, turnOffPush, turnOnPush, type PushStatus, type Quiet } from '../push.ts';
import { clearPairing, type Pairing } from '../store.ts';
import { BottomSheet } from './BottomSheet.tsx';
import { Fold } from './Fold.tsx';

type Page = 'notif' | 'defaults' | 'conn';

type Props = {
  /** 開いているか。閉じると下がって消える（動きを減らす設定ではすぐ外す）。 */
  open: boolean;
  pairing: Pairing;
  /** 受信箱で最後に読めたもの。接続先の名前と、既定の PC とアカウントの選択肢をここから読む。まだ読めていなければ null。 */
  view: InboxView | null;
  /** 「完了」。 */
  onClose: () => void;
  /** 「QR を読んで接続し直す」。参加の画面へ進む（今の接続は消さない）。 */
  onRescan: () => void;
  /** このスマホの接続を外し終えた。old は口の無い古い Worker で、手元だけを消した。 */
  onLeft: (kind: 'left' | 'old') => void;
};

const pad = (n: number): string => String(n).padStart(2, '0');
/** 分を「23:00」「7:00」にする（受信箱と同じ、時は 0 を詰めない）。 */
const hm = (min: number): string => `${Math.floor(min / 60)}:${pad(min % 60)}`;
/** 分を input type="time" の値（「07:00」）にする。 */
const timeValue = (min: number): string => `${pad(Math.floor(min / 60))}:${pad(min % 60)}`;
/** input type="time" の値を分にする。空や形の違う値は null。 */
function minuteOf(v: string): number | null {
  const m = /^(\d{1,2}):(\d{2})/.exec(v);
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  return h < 24 && mi < 60 ? h * 60 + mi : null;
}
/** 日付（「10月18日」）。受信箱の日付と同じ書き方。 */
const dayOf = (ms: number): string => {
  const d = new Date(ms);
  return `${d.getMonth() + 1}月${d.getDate()}日`;
};

/** 一覧の通知の行に添える今の値。 */
function pushSummary(s: PushStatus | null, quiet: Quiet): string {
  if (!s) return '';
  if (s.kind === 'unsupported') return '使えません';
  if (s.kind !== 'on') return 'オフ';
  return quiet ? `オン・${hm(quiet.start)}〜${hm(quiet.end)} は鳴らさない` : 'オン・夜も鳴らす';
}

/** 保存の知らせ。「保存中…」から「保存しました」に変わり、少しして薄れて消える。 */
const SAVED_SHOW_MS = 1300;
type Saved = { text: string; shown: boolean };

const BODY = ['body'];
const TIMES = ['times'];
const NONE: string[] = [];

/**
 * スマホの設定の画面（受信箱の見出しの歯車から開く）。
 * 最初は 3 行の一覧（通知、新しい会話の既定、接続）で、各行に今の値を添える。
 * 行を押すと右からページが出て、一覧は少し左へずれる。
 */
export function SettingsScreen({ open, pairing, view, onClose, onRescan, onLeft }: Props): ReactNode {
  const outer = useSheetPhase(open);
  const titleId = useId();
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // 各ページ。閉じる動きの間は、閉じたページの中身のまま残す。
  const [page, setPage] = useState<Page | null>(null);
  const lastPage = useRef<Page>('notif');
  if (page) lastPage.current = page;
  const sub = useSheetPhase(page !== null);
  const pageRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (page) pageRef.current?.focus({ preventScroll: true });
  }, [page]);

  // 通知。押したときの操作の中で turnOnPush を呼ぶ（iOS は操作の外で許可を求めると断る）。
  const [status, setStatus] = useState<PushStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [failed, setFailed] = useState(false);
  const [initialQuiet] = useState(() => pushQuiet(pairing));
  const [mute, setMute] = useState(initialQuiet !== null);
  const [times, setTimes] = useState<{ start: number; end: number }>(() => initialQuiet ?? { start: PUSH_QUIET_DEFAULT.start, end: PUSH_QUIET_DEFAULT.end });
  const quiet: Quiet = mute && times.start !== times.end ? times : null;
  const [saved, setSaved] = useState<Saved>({ text: '', shown: false });
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const want = useRef<{ q: Quiet } | null>(null);
  const sending = useRef(false);

  useEffect(() => {
    const read = (): void => {
      if (busyRef.current) return;
      void readPushStatus(pairing).then(
        (s) => {
          if (alive.current && !busyRef.current) setStatus(s);
        },
        () => undefined,
      );
    };
    read();
    // 端末の設定で通知を許可して戻ってきたときにも読み直す。
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') read();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [pairing]);
  useEffect(
    () => () => {
      if (savedTimer.current) clearTimeout(savedTimer.current);
    },
    [],
  );

  const showSaving = (): void => {
    if (savedTimer.current) clearTimeout(savedTimer.current);
    setSaved({ text: '保存中…', shown: true });
  };
  const showSaved = (): void => {
    if (savedTimer.current) clearTimeout(savedTimer.current);
    setSaved({ text: '保存しました', shown: true });
    savedTimer.current = setTimeout(() => setSaved((s) => ({ ...s, shown: false })), SAVED_SHOW_MS);
  };
  const hideSaved = (): void => {
    if (savedTimer.current) clearTimeout(savedTimer.current);
    setSaved({ text: '', shown: false });
  };

  const togglePush = (): void => {
    if (busyRef.current || !status) return;
    const wasOn = status.kind === 'on';
    busyRef.current = true;
    setBusy(true);
    setFailed(false);
    showSaving();
    (wasOn ? turnOffPush(pairing) : turnOnPush(pairing, { quiet }))
      .then(
        (s) => {
          if (!alive.current) return;
          setStatus(s);
          if (s.kind === 'on' || wasOn) showSaved();
          else hideSaved();
        },
        () => {
          if (!alive.current) return;
          setFailed(true);
          hideSaved();
        },
      )
      .finally(() => {
        busyRef.current = false;
        if (alive.current) setBusy(false);
      });
  };

  // 夜の時間帯は変えたらすぐ送る。送っている間に変わったら、終わってから最後の値を送る。
  const saveQuiet = (q: Quiet): void => {
    want.current = { q };
    setFailed(false);
    showSaving();
    if (sending.current) return;
    sending.current = true;
    void (async () => {
      let ok = true;
      while (want.current) {
        const next = want.current.q;
        want.current = null;
        try {
          await setPushQuiet(pairing, next);
          ok = true;
        } catch {
          ok = false;
        }
      }
      sending.current = false;
      if (!alive.current) return;
      if (ok) showSaved();
      else {
        hideSaved();
        setFailed(true);
      }
    })();
  };
  const toggleMute = (): void => {
    const next = !mute;
    setMute(next);
    saveQuiet(next && times.start !== times.end ? times : null);
  };
  const changeTime = (k: 'start' | 'end', v: string): void => {
    const min = minuteOf(v);
    if (min === null) return;
    const next = { ...times, [k]: min };
    setTimes(next);
    saveQuiet(mute && next.start !== next.end ? next : null);
  };

  // 新しい会話の既定。
  const [defaults, setDefaults] = useState<LaunchDefaults>(loadLaunchDefaults);
  const choices = useDefaultChoices(view);
  const pickDefault = <K extends keyof LaunchDefaults>(k: K, v: LaunchDefaults[K]): void => {
    const next = { ...defaults, [k]: v };
    // PC を変えて、前のアカウントがその PC に無ければ、アカウントを指定なしに戻す。
    if (k === 'pc' && v && next.account && !choices.accountsOf(v as string).some((a) => a.id === next.account)) next.account = null;
    saveLaunchDefaults(next);
    setDefaults(next);
  };
  const defaultsSummary =
    [
      defaults.pc ? choices.pcName(defaults.pc) : '',
      defaults.account ? choices.accountName(defaults.account) : '',
      defaults.permissionMode ? permissionName(defaults.permissionMode) : '',
      defaults.model,
      defaults.effort ? `effort ${defaults.effort}` : '',
    ]
      .filter(Boolean)
      .join('・') || 'すべてデフォルト';

  // 接続。
  const devices = view ? view.devices.map((d) => d.name || d.id).join('、') : '';
  const [confirm, setConfirm] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [leaveError, setLeaveError] = useState<string | null>(null);
  const leave = async (): Promise<void> => {
    if (leaving) return;
    setLeaving(true);
    setLeaveError(null);
    let kind: 'left' | 'old';
    try {
      kind = await leavePhone(pairing);
    } catch (e) {
      if (!alive.current) return;
      setLeaving(false);
      setLeaveError(
        e instanceof LeaveError && e.reason === 'server'
          ? `接続を外せませんでした（${e.status ?? '不明'}）。少し待ってから、もう一度タップしてください。`
          : '接続を外せませんでした。通信を確認して、もう一度タップしてください。',
      );
      return;
    }
    // 外れたら、通知の購読を解除し（Worker に送れなくても手元は消す）、接続とキーと既定を消す。
    await turnOffPush(pairing).catch(() => undefined);
    await clearPairing();
    clearLaunchDefaults();
    onLeft(kind);
  };
  const closeConfirm = (): void => {
    if (leaving) return;
    setConfirm(false);
    setLeaveError(null);
  };

  if (!outer.mounted) return null;
  const shown = page ?? lastPage.current;
  return (
    <>
      <div className={`set ${outer.leaving ? 'leaving' : ''}`} role="dialog" aria-modal="true" aria-labelledby={titleId} inert={outer.leaving || confirm}>
        <div className={`set-layer set-list ${page ? 'pushed' : ''}`} inert={page !== null}>
          <header className="set-top">
            <h1 className="set-title" id={titleId}>
              設定
            </h1>
            <button type="button" className="set-done" onClick={onClose}>
              完了
            </button>
          </header>
          <div className="set-grp">
            <ListRow label="通知" value={pushSummary(status, quiet)} onClick={() => setPage('notif')} />
            <ListRow label="新しい会話の既定" value={defaultsSummary} onClick={() => setPage('defaults')} />
            <ListRow label="接続" value={devices} onClick={() => setPage('conn')} />
          </div>
        </div>

        {sub.mounted && (
          <section ref={pageRef} className={`set-layer set-page ${sub.leaving ? 'leaving' : ''}`} inert={sub.leaving} tabIndex={-1} aria-labelledby={`${titleId}-${shown}`}>
            <div className="set-top">
              <button type="button" className="set-back" onClick={() => setPage(null)}>
                ‹ 設定
              </button>
            </div>
            {shown === 'notif' && (
              <>
                <h2 className="set-h" id={`${titleId}-notif`}>
                  通知
                </h2>
                <NotifBody
                  status={status}
                  busy={busy}
                  failed={failed}
                  mute={mute}
                  times={times}
                  saved={saved}
                  onTogglePush={togglePush}
                  onToggleMute={toggleMute}
                  onTime={changeTime}
                />
              </>
            )}
            {shown === 'defaults' && (
              <>
                <h2 className="set-h" id={`${titleId}-defaults`}>
                  新しい会話の既定
                </h2>
                <DefaultsBody defaults={defaults} choices={choices} onPick={pickDefault} />
              </>
            )}
            {shown === 'conn' && (
              <>
                <h2 className="set-h" id={`${titleId}-conn`}>
                  接続
                </h2>
                <div className="set-grp">
                  <Item label="接続先" value={devices || '不明'} />
                  <Item label="接続した日" value={pairing.joinedAt !== undefined ? dayOf(pairing.joinedAt) : '不明'} />
                  {pairing.joinedAt !== undefined && <Item label="接続し直す期限" value={`${dayOf(pairing.joinedAt + PHONE_MAX_AGE_MS)}まで`} />}
                  <button type="button" className="set-it act" onClick={onRescan}>
                    QR を読んで接続し直す
                  </button>
                </div>
                <p className="set-foot">30 日使わないか、接続から 90 日たつと切れます。切れたら PC の設定で QR を出して読み直してください。</p>
                <div className="set-grp set-gap">
                  <button type="button" className="set-it danger" onClick={() => setConfirm(true)}>
                    このスマホの接続を外す
                  </button>
                </div>
              </>
            )}
          </section>
        )}
      </div>

      <BottomSheet open={outer.mounted && confirm} title="このスマホの接続を外しますか？" onClose={closeConfirm}>
        <div className="set-confirm">
          <p className="set-confirm-t">受信箱が見えなくなり、通知も止まります。また使うときは、PC の設定で QR を出して読み直してください。</p>
          {leaveError && (
            <p className="strip danger m-fade" role="alert">
              {leaveError}
            </p>
          )}
          <button type="button" className="set-danger-btn" disabled={leaving} onClick={() => void leave()}>
            {leaving ? '接続を外しています…' : '接続を外す'}
          </button>
          <button type="button" className="set-cancel-btn" disabled={leaving} onClick={closeConfirm}>
            キャンセル
          </button>
        </div>
      </BottomSheet>
    </>
  );
}

function ListRow({ label, value, onClick }: { label: string; value: string; onClick: () => void }): ReactNode {
  return (
    <button type="button" className="set-it" onClick={onClick}>
      <span className="set-k">{label}</span>
      <span className="set-v">
        <span>{value}</span>
        <span className="chev" aria-hidden="true">
          ›
        </span>
      </span>
    </button>
  );
}

function Item({ label, value }: { label: string; value: string }): ReactNode {
  return (
    <div className="set-it">
      <span className="set-k">{label}</span>
      <span className="set-v">
        <span>{value}</span>
      </span>
    </div>
  );
}

function Switch({ label, on, disabled, onClick }: { label: string; on: boolean; disabled?: boolean; onClick: () => void }): ReactNode {
  return <button type="button" role="switch" className="sw" aria-checked={on} aria-label={label} disabled={disabled} onClick={onClick} />;
}

type NotifProps = {
  status: PushStatus | null;
  busy: boolean;
  failed: boolean;
  mute: boolean;
  times: { start: number; end: number };
  saved: Saved;
  onTogglePush: () => void;
  onToggleMute: () => void;
  onTime: (k: 'start' | 'end', v: string) => void;
};

/** 通知のページ。オンのときだけ「夜は鳴らさない」を開き、それがオンのときだけ開始と終了を開く。 */
function NotifBody({ status, busy, failed, mute, times, saved, onTogglePush, onToggleMute, onTime }: NotifProps): ReactNode {
  const isOn = status?.kind === 'on';
  const body = usePresence(isOn ? BODY : NONE, (k) => k);
  const timeRows = usePresence(mute ? TIMES : NONE, (k) => k);
  if (status?.kind === 'unsupported') {
    return (
      <>
        <div className="set-grp">
          <div className="set-it">
            <span className="set-k">このブラウザでは通知を使えません</span>
          </div>
        </div>
        {status.ios && <p className="set-foot">iPhone と iPad では、ホーム画面に追加した hangar で「通知を受け取る」を押すと使えます。</p>}
      </>
    );
  }
  return (
    <>
      <div className="set-grp">
        <div className="set-it">
          <span className="set-k">通知を受け取る</span>
          <Switch label="通知を受け取る" on={isOn} disabled={busy || !status} onClick={onTogglePush} />
        </div>
        {body.map((b) => (
          <Fold key={b.key} phase={b.phase} className="set-fold">
            <div className="set-it">
              <span className="set-k">夜は鳴らさない</span>
              <Switch label="夜は鳴らさない" on={mute} disabled={busy} onClick={onToggleMute} />
            </div>
            {timeRows.map((t) => (
              <Fold key={t.key} phase={t.phase} className="set-fold">
                <div className="set-times">
                  <input type="time" className="set-time" aria-label="開始" value={timeValue(times.start)} onChange={(e) => onTime('start', e.target.value)} />
                  <span aria-hidden="true">〜</span>
                  <input type="time" className="set-time" aria-label="終了" value={timeValue(times.end)} onChange={(e) => onTime('end', e.target.value)} />
                </div>
              </Fold>
            ))}
          </Fold>
        ))}
      </div>
      <div className="set-foot set-foot-row">
        <span>このスマホの時刻で判定します。ほかのスマホには効きません。</span>
        <span className={`set-saved ${saved.shown ? '' : 'hide'}`} role="status">
          {saved.text}
        </span>
      </div>
      {status?.kind === 'denied' && !failed && <p className="set-foot">通知が許可されていません。設定で hangar の通知を許可してから、もう一度押してください。</p>}
      {failed && (
        <p className="set-foot warn" role="alert">
          通知を設定できませんでした。通信を確認して、もう一度押してください。
        </p>
      )}
    </>
  );
}

type DefaultChoices = {
  pcs: { id: string; name: string }[];
  accountsOf: (pc: string | null) => { id: string; name: string }[];
  pcName: (id: string) => string;
  accountName: (id: string) => string;
};

/**
 * 既定の選択肢。新しい会話の画面と同じく、受信箱の素（feed を出す PC と、その PC のアカウント）から選ぶ。
 * PC を指定しないときのアカウントは、どの PC のものでもよいので、全 PC の和にする。
 */
function useDefaultChoices(view: InboxView | null): DefaultChoices {
  return useMemo(() => {
    const feeds = view?.feeds ?? [];
    const names = new Map(feeds.map((f) => [f.deviceId, f.deviceName || f.deviceId]));
    for (const d of view?.devices ?? []) if (d.name && names.has(d.id)) names.set(d.id, d.name);
    const accts = new Map(feeds.map((f) => [f.deviceId, (Array.isArray(f.accounts) ? f.accounts : []).map((a: MobileAccount) => ({ id: a.id, name: a.name || a.id }))]));
    const all = new Map<string, { id: string; name: string }>();
    for (const list of accts.values()) for (const a of list) if (!all.has(a.id)) all.set(a.id, a);
    return {
      pcs: [...names].map(([id, name]) => ({ id, name })),
      accountsOf: (pc) => (pc ? (accts.get(pc) ?? []) : [...all.values()]),
      pcName: (id) => names.get(id) ?? id,
      accountName: (id) => all.get(id)?.name ?? id,
    };
  }, [view]);
}

type DefKey = keyof LaunchDefaults;
type Opt = { value: string; label: string };
const NOT_SET = '指定なし';

/** 新しい会話の既定のページ。5 行のどれかを押すと、その下に選択肢が開く（開くのは 1 つだけ）。 */
function DefaultsBody({ defaults, choices, onPick }: { defaults: LaunchDefaults; choices: DefaultChoices; onPick: <K extends DefKey>(k: K, v: LaunchDefaults[K]) => void }): ReactNode {
  const [opened, setOpened] = useState<DefKey | null>(null);
  const [swapped, setSwapped] = useState<DefKey | null>(null);
  const rows: { k: DefKey; label: string; value: string; options: Opt[] }[] = [
    {
      k: 'pc',
      label: 'PC',
      value: defaults.pc ? choices.pcName(defaults.pc) : NOT_SET,
      options: [{ value: '', label: NOT_SET }, ...choices.pcs.map((p) => ({ value: p.id, label: p.name }))],
    },
    {
      k: 'account',
      label: 'アカウント',
      value: defaults.account ? choices.accountName(defaults.account) : NOT_SET,
      options: [{ value: '', label: NOT_SET }, ...choices.accountsOf(defaults.pc).map((a) => ({ value: a.id, label: a.name }))],
    },
    { k: 'permissionMode', label: '権限', value: permissionName(defaults.permissionMode), options: PERMISSION_OPTIONS.map((v) => ({ value: v, label: permissionName(v) })) },
    { k: 'model', label: 'モデル', value: defaults.model || DEFAULT_LABEL, options: MODEL_OPTIONS.map((v) => ({ value: v, label: v || DEFAULT_LABEL })) },
    { k: 'effort', label: 'effort', value: defaults.effort || DEFAULT_LABEL, options: EFFORT_OPTIONS.map((v) => ({ value: v, label: v || DEFAULT_LABEL })) },
  ];
  const pick = (k: DefKey, v: string): void => {
    setSwapped(k);
    if (k === 'pc' || k === 'account') onPick(k, v || null);
    else onPick(k, v);
  };
  const current = (k: DefKey): string => defaults[k] ?? '';
  return (
    <>
      <div className="set-grp">
        {rows.map((r) => (
          <DefaultRow
            key={r.k}
            label={r.label}
            value={r.value}
            swap={swapped === r.k}
            open={opened === r.k}
            onToggle={() => setOpened((o) => (o === r.k ? null : r.k))}
            options={r.options}
            checked={current(r.k)}
            danger={r.k === 'permissionMode' ? 'bypassPermissions' : null}
            onPick={(v) => pick(r.k, v)}
          />
        ))}
      </div>
      <p className="set-foot">新しい会話の画面を開いたときに、最初から選んでおく値です。</p>
    </>
  );
}

type DefaultRowProps = {
  label: string;
  value: string;
  swap: boolean;
  open: boolean;
  onToggle: () => void;
  options: Opt[];
  checked: string;
  danger: string | null;
  onPick: (v: string) => void;
};

function DefaultRow({ label, value, swap, open, onToggle, options, checked, danger, onPick }: DefaultRowProps): ReactNode {
  const shown = usePresence(open ? BODY : NONE, (k) => k);
  const id = useId();
  return (
    <>
      <button type="button" className={`set-it ${open ? 'open' : ''}`} aria-expanded={open} aria-controls={id} onClick={onToggle}>
        <span className="set-k">{label}</span>
        <span className="set-v">
          <span key={value} className={swap ? 'set-swap' : undefined}>
            {value}
          </span>
          <span className="chev" aria-hidden="true">
            ›
          </span>
        </span>
      </button>
      <div id={id}>
        {shown.map((s) => (
          <Fold key={s.key} phase={s.phase} className="set-fold">
            <div className="set-chips" role="radiogroup" aria-label={label}>
              {options.map((o) => (
                <button
                  key={o.value}
                  type="button"
                  role="radio"
                  aria-checked={checked === o.value}
                  className={`set-chip ${danger === o.value ? 'danger' : ''}`}
                  onClick={() => onPick(o.value)}
                >
                  {o.label}
                </button>
              ))}
            </div>
          </Fold>
        ))}
      </div>
    </>
  );
}
