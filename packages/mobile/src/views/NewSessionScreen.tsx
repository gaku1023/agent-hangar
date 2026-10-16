import { MODEL_CHOICES, PERMISSION_MODE_VALUES } from '@agent-hangar/shared/src/launchChoices.ts';
import { MOBILE_PROMPT_MAX, type MobileAccount, type MobileLaunchAnswer } from '@agent-hangar/shared/src/mobile.ts';
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { LaunchError } from '../api.ts';
import type { InboxView } from '../inbox.ts';
import { launchChoices, requestLaunch, waitLaunch, type LaunchStage } from '../launch.ts';
import { phaseClass, usePresence } from '../presence.ts';
import { clearPairing, type Pairing } from '../store.ts';

/** 最初の指示の上限。PC はこれより長い依頼を断る。 */
export const PROMPT_MAX = MOBILE_PROMPT_MAX;
/** 残りがこの字数を切ったら、残りの字数を出す。 */
const PROMPT_NEAR = 500;

/**
 * 権限モードの表示名。PC の新規セッションのダイアログ（packages/ui の permissionModel.ts と ja の launch.value.default）と同じ文。
 * スマホは packages/ui を読まないので写して持つ。並びと値は shared の PERMISSION_MODE_VALUES。
 */
const PERMISSION_NAMES: Record<(typeof PERMISSION_MODE_VALUES)[number], string> = {
  '': 'デフォルト',
  plan: 'Plan',
  manual: 'Manual',
  acceptEdits: 'Accept edits',
  auto: 'Auto',
  dontAsk: "Don't ask",
  bypassPermissions: 'Bypass permissions',
};
const DEFAULT_LABEL = 'デフォルト';

/** 候補が無いときの空の並び。描くたびに新しい配列を作らない（usePresence に同じものを渡す）。 */
const NO_PCS: string[] = [];
const NO_ACCOUNTS: MobileAccount[] = [];

type Sel = { scratch: true } | { scratch: false; id: string } | null;

type Stage =
  | { kind: 'idle' }
  | { kind: 'sending' }
  | { kind: 'waiting' }
  | { kind: 'started' }
  | { kind: 'unreadable' }
  | { kind: 'unanswered' }
  | { kind: 'failed'; message: string; detail?: string; reconnect?: boolean };

type Props = {
  pairing: Pairing;
  cryptoKey: CryptoKey;
  /** 受信箱で読んだもの。PC ごとのプロジェクトとアカウント、生きている PC をここから読む。 */
  view: InboxView;
  /** 閉じる。refresh は Worker が依頼を受けたか（受信箱を読み直す）。 */
  onClose: (refresh: boolean) => void;
  /** 接続が外された（401）か、接続し直すと決めた。 */
  onUnpaired: () => void;
  /** 閉じる動きの間。押せないようにして、下がって消える。 */
  leaving?: boolean;
  /** 依頼の状態を読む間隔。試験で縮める。 */
  everyMs?: number;
  /** 依頼の答えを待つのをやめるまでの長さ。試験で縮める。 */
  giveUpMs?: number;
};

function answerMessage(pc: string, a: MobileLaunchAnswer | undefined): Stage {
  if (!a || a.ok) return { kind: 'failed', message: `${pc} で会話を起こせませんでした。` };
  switch (a.reason) {
    case 'project-missing':
      return { kind: 'failed', message: 'その PC にプロジェクトの場所がありません。別の PC を選ぶか、PC の hangar で場所を足してください。' };
    case 'account-missing':
      return { kind: 'failed', message: 'その PC に選んだアカウントがありません。アカウントを選び直してください。' };
    case 'bad-payload':
      return { kind: 'failed', message: `${pc} が依頼を開けませんでした。鍵が合っていないようです。PC の設定 › クラウド で新しい QR を出し、このスマホを接続し直してください。`, reconnect: true };
    case 'expired':
      return { kind: 'failed', message: `${pc} が受け取ったときには時間切れでした。もう一度送ってください。` };
    default:
      return { kind: 'failed', message: `${pc} で会話を起こせませんでした。`, detail: typeof a.detail === 'string' && a.detail.trim() ? a.detail : undefined };
  }
}

function requestMessage(pc: string, e: unknown): Stage {
  const reason = e instanceof LaunchError ? e.reason : 'server';
  const status = e instanceof LaunchError ? e.status : null;
  switch (reason) {
    case 'rate-limited':
      return { kind: 'failed', message: '送りすぎです。新しい会話の依頼は 10 分に 10 件までです。しばらく待ってから送ってください。' };
    case 'not-found':
      return { kind: 'failed', message: `${pc} はもうクラウドに参加していません。別の PC を選んでください。` };
    case 'conflict':
      return { kind: 'failed', message: '依頼の番号が重なりました。もう一度送ってください。' };
    case 'too-large':
      return { kind: 'failed', message: '最初の指示が長すぎます。短くしてから送ってください。' };
    case 'network':
      return { kind: 'failed', message: '送れませんでした。通信を確かめて、もう一度送ってください。' };
    default:
      return { kind: 'failed', message: status ? `送れませんでした（${status}）。しばらくしてから送ってください。` : '送れませんでした。しばらくしてから送ってください。' };
  }
}

export function NewSessionScreen({ pairing, cryptoKey, view, onClose, onUnpaired, leaving, everyMs, giveUpMs }: Props): ReactNode {
  const alive = useMemo(() => new Set(view.devices.filter((d) => d.alive).map((d) => d.id)), [view]);
  const choices = useMemo(() => launchChoices(view.feeds, alive), [view, alive]);
  const names = useMemo(() => {
    const m = new Map(view.feeds.map((f) => [f.deviceId, f.deviceName]));
    for (const d of view.devices) if (d.name) m.set(d.id, d.name);
    return m;
  }, [view]);
  const running = useMemo(() => new Map(view.feeds.map((f) => [f.deviceId, (f.live ?? []).filter((l) => l.status === 'busy' || l.status === 'idle').length])), [view]);

  const [sel, setSel] = useState<Sel>(null);
  const [pcPicked, setPcPicked] = useState<string | null>(null);
  const [acctPicked, setAcctPicked] = useState<string | null>(null);
  const [permissionMode, setPermissionMode] = useState('');
  const [model, setModel] = useState('');
  const [prompt, setPrompt] = useState('');
  const [stage, setStage] = useState<Stage>({ kind: 'idle' });
  const [sentTo, setSentTo] = useState('');
  const stop = useRef<(() => void) | null>(null);
  // 届いたか分からないまま失敗した依頼。同じ中身で送り直すときは同じ id を使い、Worker と PC に二度起こさせない。
  const unsent = useRef<{ sig: string; id: string } | null>(null);
  // Worker が依頼を受けた（閉じたら受信箱を読み直す）。
  const accepted = useRef(false);
  const mounted = useRef(true);
  const promptId = useId();

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      stop.current?.();
    };
  }, []);

  // 候補が 1 つなら選んだことにし、候補から外れた選択は外す（選び直したプロジェクトに PC が無いなど）。
  const project = sel && !sel.scratch ? (choices.projects.find((p) => p.id === sel.id) ?? null) : null;
  const pcOptions = sel ? (sel.scratch ? choices.scratchDeviceIds : (project?.deviceIds ?? NO_PCS)) : NO_PCS;
  const pc = pcPicked && pcOptions.includes(pcPicked) ? pcPicked : pcOptions.length === 1 ? pcOptions[0]! : null;
  const accounts = pc ? choices.accountsOf(pc) : NO_ACCOUNTS;
  const account = acctPicked && accounts.some((a) => a.id === acctPicked) ? acctPicked : accounts.length === 1 ? accounts[0]!.id : null;
  const pcName = pc ? (names.get(pc) ?? pc) : '';

  const tooLong = prompt.length > PROMPT_MAX;
  const left = PROMPT_MAX - prompt.length;
  // 始まったかもしれない段（started、unreadable、unanswered）では送り直させない。新しい id で二つ目の会話が起きうる。
  const locked = stage.kind === 'sending' || stage.kind === 'waiting' || stage.kind === 'started' || stage.kind === 'unreadable' || stage.kind === 'unanswered';
  const ready = !!sel && (sel.scratch || !!project) && !!pc && !!account && prompt.trim().length > 0 && !tooLong;
  const nothing = choices.scratchDeviceIds.length === 0;

  const send = async (): Promise<void> => {
    if (!ready || locked || !sel || !pc || !account) return;
    const target = pc;
    const name = pcName;
    const payload = { projectId: sel.scratch ? null : sel.id, scratch: sel.scratch, accountId: account, permissionMode, model, prompt };
    const sig = JSON.stringify([target, payload]);
    const reuse = unsent.current?.sig === sig ? unsent.current.id : null;
    const fresh = reuse ?? globalThis.crypto.randomUUID();
    unsent.current = { sig, id: fresh };
    setSentTo(name);
    setStage({ kind: 'sending' });
    let id: string;
    try {
      id = await requestLaunch(pairing, cryptoKey, { id: fresh, targetDevice: target, skewMs: view.skewMs, payload });
    } catch (e) {
      // id が重なった（409）ときだけ次は新しい id にする。ほかは届いていたかもしれないので、同じ中身なら同じ id で送り直す。
      if (e instanceof LaunchError && e.reason === 'conflict') unsent.current = null;
      if (!mounted.current) return;
      if (e instanceof LaunchError && e.reason === 'unpaired') {
        clearPairing();
        onUnpaired();
        return;
      }
      setStage(requestMessage(name, e));
      return;
    }
    // Worker が受けた。この先の「もう一度」は新しい依頼にする。
    unsent.current = null;
    accepted.current = true;
    if (!mounted.current) return;
    stop.current = waitLaunch(pairing, cryptoKey, id, {
      everyMs,
      giveUpMs,
      onStage: (s: LaunchStage, a?: MobileLaunchAnswer) => {
        if (!mounted.current) return;
        if (s === 'waiting') setStage({ kind: 'waiting' });
        else if (s === 'started') setStage({ kind: 'started' });
        else if (s === 'unreadable') setStage({ kind: 'unreadable' });
        else if (s === 'unanswered') setStage({ kind: 'unanswered' });
        else if (s === 'unpaired') {
          clearPairing();
          onUnpaired();
        }
        else if (s === 'expired') setStage({ kind: 'failed', message: `${name} が受け取りませんでした。${name} で hangar が動いているか確かめて、もう一度送ってください。` });
        else setStage(answerMessage(name, a));
      },
    });
  };

  const reconnect = (): void => {
    clearPairing();
    onUnpaired();
  };

  return (
    <div className={`ns ${leaving ? 'leaving' : ''}`} role="dialog" aria-modal="true" aria-labelledby={`${promptId}-title`} inert={leaving}>
      <header className="ns-head">
        <button type="button" className="ns-close" onClick={() => onClose(accepted.current)}>
          閉じる
        </button>
        <h1 className="ns-title" id={`${promptId}-title`}>
          新しい会話
        </h1>
        <span aria-hidden="true" />
      </header>

      <div className="ns-scroll">
        {nothing ? (
          <p className="strip warn m-fade" role="status">
            新しい会話を受けられる PC がありません。PC の hangar が動いているか、クラウドに接続しているかを確かめてください。
          </p>
        ) : (
          <fieldset className="ns-form" disabled={locked}>
            <Group label="プロジェクト">
              <Choice checked={!!sel?.scratch} onPick={() => setSel({ scratch: true })} title="すぐ始める（フォルダなし）" />
              {choices.projects.map((p) => (
                <Choice
                  key={p.id}
                  checked={!!sel && !sel.scratch && sel.id === p.id}
                  onPick={() => setSel({ scratch: false, id: p.id })}
                  title={p.name || p.id}
                  sub={p.deviceIds.map((d) => names.get(d) ?? d).join('、')}
                />
              ))}
            </Group>

            <Group label="PC" hint={sel ? null : 'プロジェクトを選ぶと出ます'}>
              <Options
                items={pcOptions}
                keyOf={(d) => d}
                render={(d) => {
                  const n = running.get(d) ?? 0;
                  return <Choice checked={pc === d} onPick={() => setPcPicked(d)} title={names.get(d) ?? d} sub={n > 0 ? `動いている ${n}` : '空いている'} />;
                }}
              />
            </Group>

            <Group label="アカウント" hint={pc ? (accounts.length === 0 ? 'この PC にアカウントがありません' : null) : 'PC を選ぶと出ます'}>
              <Options
                items={accounts}
                keyOf={(a) => `${pc}:${a.id}`}
                render={(a) => (
                  <Choice
                    checked={account === a.id}
                    onPick={() => setAcctPicked(a.id)}
                    title={a.name || a.id}
                    dot={/^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(a.color) ? a.color : null}
                    sub={typeof a.fiveHour === 'number' ? `5時間 ${Math.round(a.fiveHour)}%` : undefined}
                  />
                )}
              />
            </Group>

            <Group label="権限モード" grid>
              {PERMISSION_MODE_VALUES.map((v) => (
                <Choice key={v} value={v} checked={permissionMode === v} onPick={() => setPermissionMode(v)} title={PERMISSION_NAMES[v]} danger={v === 'bypassPermissions'} />
              ))}
            </Group>

            <Group label="モデル" grid>
              {['', ...MODEL_CHOICES].map((m) => (
                <Choice key={m} value={m} checked={model === m} onPick={() => setModel(m)} title={m || DEFAULT_LABEL} />
              ))}
            </Group>

            <section className="ns-sec">
              <label className="ns-h" htmlFor={promptId}>
                最初の指示
              </label>
              <textarea id={promptId} className="input ns-prompt" rows={4} value={prompt} onChange={(e) => setPrompt(e.target.value)} />
              {tooLong ? (
                <p className="ns-limit over m-fade" role="status">
                  最初の指示は {PROMPT_MAX.toLocaleString('en-US')} 字までです（{(-left).toLocaleString('en-US')} 字多い）
                </p>
              ) : left < PROMPT_NEAR ? (
                <p className="ns-limit m-fade">あと {left.toLocaleString('en-US')} 字</p>
              ) : null}
            </section>
          </fieldset>
        )}
      </div>

      <div className="ns-bar">
        {/* 段が変わるときだけ薄れから現す。始めると送っているの間は同じ要素のまま（押したボタンのフォーカスを落とさない）。 */}
        <div className="ns-bar-in m-fade" key={stage.kind === 'idle' || stage.kind === 'sending' ? 'form' : stage.kind} aria-live="polite">
          {(stage.kind === 'idle' || stage.kind === 'sending') && (
            <button type="button" className="ns-start" disabled={!ready || stage.kind === 'sending'} onClick={() => void send()}>
              {stage.kind === 'sending' ? '送っています…' : pc ? `${pcName} で始める` : '始める'}
            </button>
          )}
          {stage.kind === 'waiting' && (
            <p className="ns-stage">
              <span className="pull-ring spin" aria-hidden="true" />
              {`${sentTo} が受け取るのを待っています（最大 30 秒ほど）`}
            </p>
          )}
          {stage.kind === 'started' && (
            <div className="ns-done">
              <p className="ns-stage ok">
                <span className="dot done" aria-hidden="true" />
                {`${sentTo} で始まりました。受信箱の「動いている」に出ます。`}
              </p>
              <button type="button" className="ns-start" onClick={() => onClose(true)}>
                受信箱へ ›
              </button>
            </div>
          )}
          {stage.kind === 'unreadable' && (
            <div className="ns-done">
              <p className="ns-stage bad" role="alert">
                {`${sentTo} からの返事を読めませんでした。会話が始まっているかもしれません。受信箱で確かめてください。`}
              </p>
              <button type="button" className="ns-start" onClick={() => onClose(true)}>
                受信箱へ ›
              </button>
            </div>
          )}
          {stage.kind === 'unanswered' && (
            <div className="ns-done">
              <p className="ns-stage bad" role="alert">
                {`${sentTo} は受け取りましたが、結果がまだ届いていません。受信箱で確かめてから送り直してください。`}
              </p>
              <button type="button" className="ns-start" onClick={() => onClose(true)}>
                受信箱へ ›
              </button>
            </div>
          )}
          {stage.kind === 'failed' && (
            <div className="ns-done">
              <p className="ns-stage bad" role="alert">
                {stage.message}
              </p>
              {stage.detail && <p className="ns-detail">{stage.detail}</p>}
              <div className="ns-actions">
                {stage.reconnect && (
                  <button type="button" className="ns-start sec" onClick={reconnect}>
                    接続し直す
                  </button>
                )}
                <button type="button" className="ns-start" onClick={() => setStage({ kind: 'idle' })}>
                  もう一度
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Group({ label, hint, grid, children }: { label: string; hint?: string | null; grid?: boolean; children: ReactNode }): ReactNode {
  const id = useId();
  return (
    <section className="ns-sec">
      <h2 className="ns-h" id={id}>
        {label}
      </h2>
      {hint && <p className="ns-hint m-fade">{hint}</p>}
      <div role="radiogroup" aria-labelledby={id} className={grid ? 'ns-grid' : 'ns-list'}>
        {children}
      </div>
    </section>
  );
}

/** 候補が入れ替わる組（PC、アカウント）。増えたものは伸びて入り、消えたものは畳んで出る。 */
function Options<T>({ items, keyOf, render }: { items: readonly T[]; keyOf: (t: T) => string; render: (t: T) => ReactNode }): ReactNode {
  const list = usePresence(items, keyOf);
  return (
    <>
      {list.map((p) => (
        <div key={p.key} className={`fold ${phaseClass(p.phase)}`} aria-hidden={p.phase === 'leave' ? true : undefined}>
          <div className="fold-in">
            <div className="fold-pad">{render(p.item)}</div>
          </div>
        </div>
      ))}
    </>
  );
}

function Choice({ checked, onPick, title, sub, dot, value, danger }: { checked: boolean; onPick: () => void; title: string; sub?: string; dot?: string | null; value?: string; danger?: boolean }): ReactNode {
  return (
    <button type="button" role="radio" aria-checked={checked} data-value={value} className={`choice ${checked ? 'on' : ''} ${danger ? 'danger' : ''}`} onClick={onPick}>
      {dot !== undefined && <span className="acct-dot" style={dot ? { background: dot } : undefined} aria-hidden="true" />}
      <span className="choice-title">{title}</span>
      {sub && <span className="choice-sub">{sub}</span>}
    </button>
  );
}
