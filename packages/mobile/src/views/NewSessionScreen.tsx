import { EFFORT_VALUES, MODEL_CHOICES, PERMISSION_MODE_VALUES } from '@agent-hangar/shared/src/launchChoices.ts';
import { MOBILE_PROMPT_MAX, type MobileAccount } from '@agent-hangar/shared/src/mobile.ts';
import { useId, useMemo, useState, type ReactNode } from 'react';
import { createAsker, type Asker } from '../ask.ts';
import { useAttachments, type PutImage, type Shrink } from '../images.ts';
import type { InboxView } from '../inbox.ts';
import { launchChoices } from '../launch.ts';
import type { LaunchSpec } from '../launchRun.ts';
import { phaseClass, usePresence } from '../presence.ts';
import type { Pairing } from '../store.ts';
import { Choice } from './Choice.tsx';
import { Composer } from './Composer.tsx';
import { Fold } from './Fold.tsx';
import { ProjectPicker, type Sel } from './ProjectPicker.tsx';

/** 初期プロンプトの上限。PC はこれより長い依頼を断る。 */
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
const NO_ITEMS: string[] = [];
const ADV_ON = ['adv'];
const NOTE_ON = ['note'];

const COLOR = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const safeColor = (c: string): string | null => (COLOR.test(c) ? c : null);

type Props = {
  /** 受信箱で読んだもの。PC ごとのプロジェクトとアカウント、生きている PC をここから読む。 */
  view: InboxView;
  /** 候補の問い合わせと画像の置き場に使う。 */
  pairing: Pairing;
  cryptoKey: CryptoKey;
  /** 試験で差し替える口。 */
  deps?: { asker?: Asker; putImage?: PutImage; shrink?: Shrink };
  /** 「始める」。画面を閉じて、起動のシートに進みを見せるのは呼び手。 */
  onLaunch: (spec: LaunchSpec) => void;
  /** 閉じる。 */
  onClose: () => void;
  /** 閉じる動きの間。押せないようにして、下がって消える。 */
  leaving?: boolean;
};

/** 新しい会話の画面（B1 プロジェクト、C3 詳しい設定）。 */
export function NewSessionScreen({ view, pairing, cryptoKey, deps, onLaunch, onClose, leaving }: Props): ReactNode {
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
  const [effort, setEffort] = useState('');
  const [adv, setAdv] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [submitted, setSubmitted] = useState(false);
  // 依頼の ID は画面を開いたときに振る。画像はこの ID の下に置き、依頼もこの ID で出す。
  const [launchId] = useState(() => globalThis.crypto.randomUUID());
  // 候補の答えは画面の間だけ覚える（画面は開くたびに作り直す）。
  const [asker] = useState(() => deps?.asker ?? createAsker(pairing, cryptoKey));
  const att = useAttachments({ pairing, key: cryptoKey, launchId, put: deps?.putImage, shrink: deps?.shrink });
  const promptId = useId();
  const advId = useId();
  const titleId = useId();

  // 候補が 1 つなら選んだことにし、候補から外れた選択は外す（選び直したプロジェクトに PC が無いなど）。
  const project = sel && !sel.scratch ? (choices.projects.find((p) => p.id === sel.id) ?? null) : null;
  const pcOptions = sel ? (sel.scratch ? choices.scratchDeviceIds : (project?.deviceIds ?? NO_PCS)) : NO_PCS;
  const pc = pcPicked && pcOptions.includes(pcPicked) ? pcPicked : pcOptions.length === 1 ? pcOptions[0]! : null;
  const accounts = pc ? choices.accountsOf(pc) : NO_ACCOUNTS;
  const account = acctPicked && accounts.some((a) => a.id === acctPicked) ? acctPicked : accounts.length === 1 ? accounts[0]!.id : null;
  const accountOf = account ? (accounts.find((a) => a.id === account) ?? null) : null;
  const pcName = pc ? (names.get(pc) ?? pc) : '';

  const tooLong = prompt.length > PROMPT_MAX;
  const left = PROMPT_MAX - prompt.length;
  const hasText = prompt.trim().length > 0 || att.ready.length > 0;
  const ready = !!sel && (sel.scratch || !!project) && !!pc && !!account && hasText && !att.busy && !att.failed && !tooLong && !submitted;
  const nothing = choices.scratchDeviceIds.length === 0;

  const advShown = usePresence(adv ? ADV_ON : NO_ITEMS, (k) => k);
  const noteShown = usePresence(effort === 'xhigh' || effort === 'max' ? NOTE_ON : NO_ITEMS, (k) => k);
  const summary = [
    permissionMode ? `権限 ${PERMISSION_NAMES[permissionMode as keyof typeof PERMISSION_NAMES] ?? permissionMode}` : '',
    model ? `モデル ${model}` : '',
    effort ? `effort ${effort}` : '',
  ].filter(Boolean);

  const start = (): void => {
    if (!ready || !sel || !pc || !account) return;
    setSubmitted(true);
    const images = att.ready;
    onLaunch({
      targetDevice: pc,
      pcName,
      projectName: sel.scratch ? null : (project?.name || project?.id || null),
      accountId: account,
      accountName: accountOf ? accountOf.name || accountOf.id : null,
      accountColor: accountOf ? safeColor(accountOf.color) : null,
      payload: {
        projectId: sel.scratch ? null : sel.id,
        scratch: sel.scratch,
        accountId: account,
        permissionMode,
        model,
        ...(effort ? { effort } : {}),
        prompt,
        ...(images.length > 0 ? { images: images.map((i) => ({ n: i.n, mime: i.mime, bytes: i.data.length })) } : {}),
      },
      skewMs: view.skewMs,
      id: launchId,
      ...(images.length > 0 ? { images } : {}),
    });
  };

  const label = !sel
    ? 'プロジェクトを選んでください'
    : !pc
      ? 'PC を選んでください'
      : !account
        ? 'アカウントを選んでください'
        : att.failed
          ? '送信できなかった画像があります'
          : att.busy
            ? '送信中の画像を待っています'
            : `${pcName} で始める`;

  return (
    <div className={`ns ${leaving ? 'leaving' : ''}`} role="dialog" aria-modal="true" aria-labelledby={titleId} inert={leaving}>
      <header className="ns-head">
        <button type="button" className="ns-close" onClick={onClose}>
          閉じる
        </button>
        <h1 className="ns-title" id={titleId}>
          新しい会話
        </h1>
        <span aria-hidden="true" />
      </header>

      <div className="ns-scroll">
        {nothing ? (
          <p className="strip warn m-fade" role="status">
            新しい会話を受けられる PC がありません。PC の hangar が実行中か、クラウドに接続しているかを確認してください。
          </p>
        ) : (
          <fieldset className="ns-form" disabled={submitted}>
            <ProjectPicker projects={choices.projects} sel={sel} onPick={setSel} names={names} />

            <Group label="PC" hint={sel ? null : 'プロジェクトを選ぶと表示されます'}>
              <Options
                items={pcOptions}
                keyOf={(d) => d}
                render={(d) => {
                  const n = running.get(d) ?? 0;
                  return <Choice checked={pc === d} onPick={() => setPcPicked(d)} title={names.get(d) ?? d} sub={n > 0 ? `実行中 ${n}` : '空き'} />;
                }}
              />
            </Group>

            <Group label="アカウント" hint={pc ? (accounts.length === 0 ? 'この PC にアカウントがありません' : null) : 'PC を選ぶと表示されます'}>
              <Options
                items={accounts}
                keyOf={(a) => `${pc}:${a.id}`}
                render={(a) => (
                  <Choice
                    checked={account === a.id}
                    onPick={() => setAcctPicked(a.id)}
                    title={a.name || a.id}
                    dot={safeColor(a.color)}
                    sub={typeof a.fiveHour === 'number' ? `5時間 ${Math.round(a.fiveHour)}%` : undefined}
                  />
                )}
              />
            </Group>

            <section className="ns-sec">
              <label className="ns-h" htmlFor={promptId}>
                初期プロンプト
              </label>
              <Composer
                id={promptId}
                value={prompt}
                onChange={setPrompt}
                asker={asker}
                pc={pc}
                pcName={pcName}
                projectId={sel && !sel.scratch ? sel.id : null}
                projectName={project ? project.name || project.id : null}
                accountId={account}
                accountName={accountOf ? accountOf.name || accountOf.id : null}
                attachments={att}
              />
              {tooLong ? (
                <p className="ns-limit over m-fade" role="status">
                  初期プロンプトは {PROMPT_MAX.toLocaleString('en-US')} 字までです（{(-left).toLocaleString('en-US')} 字多い）
                </p>
              ) : left < PROMPT_NEAR ? (
                <p className="ns-limit m-fade">あと {left.toLocaleString('en-US')} 字</p>
              ) : null}
            </section>

            <section className="ns-sec">
              <button type="button" className={`sumrow ${adv ? 'open' : ''}`} aria-expanded={adv} aria-controls={advId} onClick={() => setAdv((v) => !v)}>
                <span className="sumrow-text">
                  <b>詳しい設定</b>
                  <small>{summary.length > 0 ? summary.join(' · ') : 'すべてデフォルト'}</small>
                </span>
                <span className="chev" aria-hidden="true">
                  ›
                </span>
              </button>
              <div id={advId}>
                {advShown.map((x) => (
                  <Fold key={x.key} phase={x.phase}>
                    <div className="adv">
                      <Group label="権限モード" grid>
                        {PERMISSION_MODE_VALUES.map((v) => (
                          <Choice key={v} small value={v} checked={permissionMode === v} onPick={() => setPermissionMode(v)} title={PERMISSION_NAMES[v]} danger={v === 'bypassPermissions'} />
                        ))}
                      </Group>
                      <Group label="モデル" grid>
                        {['', ...MODEL_CHOICES].map((m) => (
                          <Choice key={m} small value={m} checked={model === m} onPick={() => setModel(m)} title={m || DEFAULT_LABEL} />
                        ))}
                      </Group>
                      <Group label="effort" grid>
                        {EFFORT_VALUES.map((v) => (
                          <Choice key={v} small value={v} checked={effort === v} onPick={() => setEffort(v)} title={v || DEFAULT_LABEL} />
                        ))}
                      </Group>
                      {noteShown.map((n) => (
                        <div key={n.key} className={`fold ${phaseClass(n.phase)}`} aria-hidden={n.phase === 'leave' ? true : undefined}>
                          <div className="fold-in">
                            <p className="strip warn adv-note" role="note">
                              xhigh と max は考える時間が長く、使用量が増えます。
                            </p>
                          </div>
                        </div>
                      ))}
                    </div>
                  </Fold>
                ))}
              </div>
            </section>
          </fieldset>
        )}
      </div>

      <div className="ns-bar">
        <div className="ns-bar-in">
          <button type="button" className="ns-start" disabled={!ready} onClick={start}>
            {label}
          </button>
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
      <div role="radiogroup" aria-labelledby={id} className={grid ? 'ns-grid c3' : 'ns-list'}>
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
        <Fold key={p.key} phase={p.phase}>
          {render(p.item)}
        </Fold>
      ))}
    </>
  );
}
