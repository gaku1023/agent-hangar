import { MOBILE_PROMPT_MAX, type MobileAccount, type MobileAgentOptions, type MobileModelOption } from '@agent-hangar/shared/src/mobile.ts';
import { useEffect, useId, useMemo, useState, type ReactNode } from 'react';
import { workerTooOld } from '../api.ts';
import { createAsker, type Asker } from '../ask.ts';
import { useAttachments, type PutImage, type Shrink } from '../images.ts';
import type { InboxView } from '../inbox.ts';
import { launchChoices } from '../launch.ts';
import { AGENT_NAMES, DEFAULT_LABEL, EFFORT_OPTIONS, loadLaunchDefaults, MODEL_OPTIONS, PERMISSION_OPTIONS, permissionName } from '../launchDefaults.ts';
import type { LaunchSpec } from '../launchRun.ts';
import { phaseClass, usePresence } from '../presence.ts';
import type { Pairing, PhoneKey } from '../store.ts';
import { AgentIcon } from './AgentIcon.tsx';
import { Choice } from './Choice.tsx';
import { Composer } from './Composer.tsx';
import { Fold } from './Fold.tsx';
import { ProjectPicker, type Sel } from './ProjectPicker.tsx';

/** 初期プロンプトの上限。PC はこれより長い依頼を断る。 */
export const PROMPT_MAX = MOBILE_PROMPT_MAX;
/** 残りがこの字数を切ったら、残りの字数を出す。 */
const PROMPT_NEAR = 500;

/** 候補が無いときの空の並び。描くたびに新しい配列を作らない（usePresence に同じものを渡す）。 */
const NO_PCS: string[] = [];
const NO_ACCOUNTS: MobileAccount[] = [];
const NO_ITEMS: string[] = [];
const ADV_ON = ['adv'];
const NOTE_ON = ['note'];
const STEP_ON = ['step'];
const CC_ON = ['cc'];
const OC_ON = ['oc'];
const AUTO_ON = ['on'];
const AUTO_OFF = ['off'];
const NO_MODELS: MobileModelOption[] = [];
const NO_MODES: MobileAgentOptions['modes'] = [];

type Agent = 'claude-code' | 'opencode';

/** モデルの札に添える費用の型（PC のモデルの小窓と同じ語）。 */
const COST_LABEL: Record<MobileModelOption['cost'], string> = { local: 'ローカル', free: '無料', metered: '従量', plan: '定額' };
/**
 * モデルの札に添えるデータの扱い。狭い札に収めるため、PC 外へ出ないことと、気を付けるもの（⚠）だけを出す。
 * 学習に使わない、30 日保持は、PC のモデルの小窓で見る。
 */
const DATA_LABEL: Partial<Record<NonNullable<MobileModelOption['data']>, string>> = {
  'on-device': 'PC 外への送信なし',
  'may-train': '⚠ 学習利用の可能性あり',
  'provider-logs': '⚠ プロバイダー側で記録',
};
const modelSub = (m: MobileModelOption): string => [m.group, COST_LABEL[m.cost], m.data ? DATA_LABEL[m.data] : undefined].filter(Boolean).join(' · ');

/** opencode の選択肢の問い合わせの結果。key は PC とプロジェクト。 */
type OcOptions = { key: string; ok: true; value: MobileAgentOptions | null } | { key: string; ok: false };

const COLOR = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const safeColor = (c: string): string | null => (COLOR.test(c) ? c : null);

type Props = {
  /** 受信箱で読んだもの。PC ごとのプロジェクトとアカウント、生きている PC をここから読む。 */
  view: InboxView;
  /** 候補の問い合わせと画像の置き場に使う。 */
  pairing: Pairing;
  /**
   * 開いたときの、いちばん新しい世代のスマホ用の鍵。
   * 画面を閉じるまでこの鍵を使い続ける（後で変わっても読み替えない）。
   */
  phoneKey: PhoneKey;
  /** 試験で差し替える口。 */
  deps?: { asker?: Asker; putImage?: PutImage; shrink?: Shrink };
  /** 「始める」。key は画像を封じた鍵で、依頼も同じ鍵で封じる。画面を閉じて、起動のシートに進みを見せるのは呼び手。 */
  onLaunch: (spec: LaunchSpec, key: PhoneKey) => void;
  /** 閉じる。 */
  onClose: () => void;
  /** 閉じる動きの間。押せないようにして、下がって消える。 */
  leaving?: boolean;
};

/** 新しい会話の画面（B1 プロジェクト、C3 詳しい設定）。 */
export function NewSessionScreen({ view, pairing, phoneKey, deps, onLaunch, onClose, leaving }: Props): ReactNode {
  const alive = useMemo(() => new Set(view.devices.filter((d) => d.alive).map((d) => d.id)), [view]);
  const choices = useMemo(() => launchChoices(view.feeds, alive), [view, alive]);
  const names = useMemo(() => {
    const m = new Map(view.feeds.map((f) => [f.deviceId, f.deviceName]));
    for (const d of view.devices) if (d.name) m.set(d.id, d.name);
    return m;
  }, [view]);
  const running = useMemo(() => new Map(view.feeds.map((f) => [f.deviceId, (f.live ?? []).filter((l) => l.status === 'busy' || l.status === 'idle').length])), [view]);

  // 設定の「新しい会話のデフォルト」を最初から選んでおく。
  // 今そのプロジェクトに無い PC、その PC に無いアカウントは、下の候補の判定が無視する（今の初期値に戻す）。
  // caps で effort を使えない PC では effortSent が空にする。
  const [defaults] = useState(loadLaunchDefaults);
  const [sel, setSel] = useState<Sel>(null);
  const [pcPicked, setPcPicked] = useState<string | null>(defaults.pc);
  const [acctPicked, setAcctPicked] = useState<string | null>(defaults.account);
  const [permissionMode, setPermissionMode] = useState(defaults.permissionMode);
  const [model, setModel] = useState(defaults.model);
  const [effort, setEffort] = useState(defaults.effort);
  // エージェント。opencode を選べるのは、caps.agents に opencode のある PC だけである（下の canOpencode）。
  // モード、モデル、自動承認は既定に持たない（モードとモデルは PC の一覧から選び、自動承認は危ない値なので毎回オフから）。
  const [agentPicked, setAgentPicked] = useState<Agent>(defaults.agent === 'opencode' ? 'opencode' : 'claude-code');
  const [ocMode, setOcMode] = useState('');
  const [ocModel, setOcModel] = useState('');
  const [ocAuto, setOcAuto] = useState(false);
  const [ocOptions, setOcOptions] = useState<OcOptions | null>(null);
  const [adv, setAdv] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [submitted, setSubmitted] = useState(false);
  // 依頼の ID は画面を開いたときに振る。画像はこの ID の下に置き、依頼もこの ID で出す。
  const [launchId] = useState(() => globalThis.crypto.randomUUID());
  // 鍵は画面を開いたときのものに固める。
  // 開いている間に受信箱が新しい世代を読んでも、画像、問い合わせ、依頼を同じ世代で封じる（PC は依頼の世代で画像を開く）。
  const [key] = useState(() => phoneKey);
  // 候補の答えは画面の間だけ覚える（画面は開くたびに作り直す）。
  const [asker] = useState(() => deps?.asker ?? createAsker(pairing, key));
  const att = useAttachments({ pairing, key, launchId, put: deps?.putImage, shrink: deps?.shrink });
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
  // 選んだ PC ができること。caps の無い素は rc.1 の PC で、依頼の画像と effort を黙って捨て、候補も返せない。
  // PC を選ぶまでは分からないので、出しておく。
  const caps = pc ? (view.feeds.find((f) => f.deviceId === pc)?.caps ?? null) : null;
  const workerOld = workerTooOld(view.workerCompat ?? null);
  const canAsk = !workerOld && (!pc || !!caps?.asks);
  const canImages = !workerOld && (!pc || !!caps?.images);
  const canEffort = !pc || !!caps?.effort;
  // opencode は、選んだ PC が caps.agents に opencode を載せているときだけ選べる。
  // 載せていない PC（古い PC、opencode を無効にした PC）は依頼の agent を知らずに Claude を起こしてしまうので、段ごと出さず、依頼にも agent を入れない。
  const canOpencode = !!pc && !!caps?.agents?.includes('opencode');
  const oc = canOpencode && agentPicked === 'opencode';
  const effortSent = canEffort && !oc ? effort : '';

  // opencode の選択肢は、opencode を選んでいる間だけ問い合わせる。PC は手元に持った一覧を答える（取りに行かない）。
  const ocKey = oc && pc ? `${pc}\n${sel && !sel.scratch ? sel.id : ''}` : null;
  const ocProject = sel && !sel.scratch ? sel.id : null;
  useEffect(() => {
    if (!ocKey || !pc) return;
    if (workerOld) {
      setOcOptions({ key: ocKey, ok: false });
      return;
    }
    let stale = false;
    asker.agentOptions(pc, ocProject).then(
      (value) => {
        if (!stale) setOcOptions({ key: ocKey, ok: true, value });
      },
      () => {
        if (!stale) setOcOptions({ key: ocKey, ok: false });
      },
    );
    return () => {
      stale = true;
    };
    // 問い合わせは PC とプロジェクトが変わったときだけ出す（asker は画面の間同じ）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ocKey]);
  const ocNow = ocOptions && ocOptions.key === ocKey ? ocOptions : null;
  const ocList = ocNow?.ok ? ocNow.value : null;
  const ocModes = ocList?.modes ?? NO_MODES;
  const ocModels = ocList?.models ?? NO_MODELS;
  // 一覧から消えた値は送らない（PC を選び直した、一覧が変わった）。
  const ocModeSent = ocModes.some((m) => m.id === ocMode) ? ocMode : '';
  const ocModelSent = ocModels.some((m) => m.id === ocModel) ? ocModel : '';
  const ocModelName = ocModels.find((m) => m.id === ocModelSent)?.label ?? '';
  const ocHint = !ocNow ? null : !ocNow.ok || !ocNow.value ? 'モデルの一覧を取得できません。デフォルトで起動します。' : ocNow.value.stale ? 'PC の一覧（更新が古い可能性があります）' : null;
  const ocVersion = ocList?.version ? `${ocList.version} · ${ocList.verified ? '検証済み' : '未検証'}` : undefined;

  const tooLong = prompt.length > PROMPT_MAX;
  const left = PROMPT_MAX - prompt.length;
  const hasText = prompt.trim().length > 0 || att.ready.length > 0;
  const imagesBlocked = !canImages && att.items.length > 0;
  const ready = !!sel && (sel.scratch || !!project) && !!pc && (oc || !!account) && hasText && !att.busy && !att.failed && !imagesBlocked && !tooLong && !submitted;
  const nothing = choices.scratchDeviceIds.length === 0;

  const advShown = usePresence(adv ? ADV_ON : NO_ITEMS, (k) => k);
  // まだ選べない段は出さない。前の段を選ぶと、次の段が伸びて現れる。
  const pcStep = usePresence(sel ? STEP_ON : NO_ITEMS, (k) => k);
  // エージェントの段は PC の次に出る。opencode にすると、アカウントの段は畳まれる（試作 S1：既存の Fold で段ごとに畳み、伸びる）。
  const agentStep = usePresence(canOpencode ? STEP_ON : NO_ITEMS, (k) => k);
  const acctStep = usePresence(pc && !oc ? STEP_ON : NO_ITEMS, (k) => k);
  const ccAdv = usePresence(oc ? NO_ITEMS : CC_ON, (k) => k);
  const ocAdv = usePresence(oc ? OC_ON : NO_ITEMS, (k) => k);
  const autoNote = usePresence(ocAuto ? AUTO_ON : AUTO_OFF, (k) => k);
  const noteShown = usePresence(effortSent === 'xhigh' || effortSent === 'max' ? NOTE_ON : NO_ITEMS, (k) => k);
  const summary = oc
    ? [`モード ${ocModeSent || DEFAULT_LABEL}`, `モデル ${ocModelName || DEFAULT_LABEL}`, `自動承認 ${ocAuto ? 'オン' : 'オフ'}`]
    : [permissionMode ? `権限 ${permissionName(permissionMode)}` : '', model ? `モデル ${model}` : '', effortSent ? `effort ${effortSent}` : ''].filter(Boolean);

  const start = (): void => {
    if (!ready || !sel || !pc || (!oc && !account)) return;
    setSubmitted(true);
    const images = att.ready;
    const imageRefs = images.length > 0 ? { images: images.map((i) => ({ n: i.n, mime: i.mime, bytes: i.data.length })) } : {};
    const target = { projectId: sel.scratch ? null : sel.id, scratch: sel.scratch };
    onLaunch(
      {
        targetDevice: pc,
        pcName,
        projectName: sel.scratch ? null : (project?.name || project?.id || null),
        accountId: oc ? '' : account!,
        accountName: !oc && accountOf ? accountOf.name || accountOf.id : null,
        accountColor: !oc && accountOf ? safeColor(accountOf.color) : null,
        // opencode の依頼は、アカウントと権限モードを空にし、effort を入れない（PC はこれが崩れた依頼を断る）。
        payload: oc
          ? {
              ...target,
              accountId: '',
              permissionMode: '',
              model: ocModelSent,
              prompt,
              ...imageRefs,
              agent: 'opencode',
              ...(ocModeSent ? { mode: ocModeSent } : {}),
              ...(ocAuto ? { autoApprove: true } : {}),
            }
          : {
              ...target,
              accountId: account!,
              permissionMode,
              model,
              ...(effortSent ? { effort: effortSent } : {}),
              prompt,
              ...imageRefs,
            },
        skewMs: view.skewMs,
        id: launchId,
        ...(images.length > 0 ? { images } : {}),
      },
      key,
    );
  };

  const label = !sel
    ? 'プロジェクトを選んでください'
    : !pc
      ? 'PC を選んでください'
      : !oc && !account
        ? 'アカウントを選んでください'
        : imagesBlocked
          ? 'この PC では画像を添付できません'
          : att.failed
            ? '送信できなかった画像があります'
            : att.busy
              ? '画像の送信中…'
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

            {pcStep.map((s) => (
              <Fold key={s.key} phase={s.phase} className="ns-step">
                <Group label="PC">
                  <Options
                    items={pcOptions}
                    keyOf={(d) => d}
                    render={(d) => {
                      const n = running.get(d) ?? 0;
                      return <Choice checked={pc === d} onPick={() => setPcPicked(d)} title={names.get(d) ?? d} sub={n > 0 ? `実行中 ${n}` : undefined} />;
                    }}
                  />
                </Group>
              </Fold>
            ))}

            {agentStep.map((s) => (
              <Fold key={s.key} phase={s.phase} className="ns-step">
                <Group label="エージェント">
                  <Choice checked={!oc} onPick={() => setAgentPicked('claude-code')} title={AGENT_NAMES['claude-code']} icon={<AgentIcon kind="claude-code" />} />
                  <Choice checked={oc} onPick={() => setAgentPicked('opencode')} title={AGENT_NAMES.opencode} badge="ベータ" sub={oc ? ocVersion : undefined} icon={<AgentIcon kind="opencode" />} />
                </Group>
              </Fold>
            ))}

            {acctStep.map((s) => (
              <Fold key={s.key} phase={s.phase} className="ns-step">
                <Group label="アカウント" hint={accounts.length === 0 ? 'この PC にアカウントがありません' : null}>
                  <Options
                    items={accounts}
                    keyOf={(a) => `${pc}:${a.id}`}
                    render={(a) => (
                      <Choice
                        checked={account === a.id}
                        onPick={() => setAcctPicked(a.id)}
                        title={a.name || a.id}
                        dot={safeColor(a.color)}
                        sub={typeof a.fiveHour === 'number' ? `5 時間 ${Math.round(a.fiveHour)}%` : undefined}
                      />
                    )}
                  />
                </Group>
              </Fold>
            ))}

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
                accountId={oc ? null : account}
                accountName={!oc && accountOf ? accountOf.name || accountOf.id : null}
                agent={oc ? 'opencode' : undefined}
                attachments={att}
                canAsk={canAsk}
                canAttach={canImages}
              />
              {tooLong ? (
                <p className="ns-limit over m-fade" role="status">
                  {`${(-left).toLocaleString('en-US')} 字多い`}
                </p>
              ) : left < PROMPT_NEAR ? (
                <p className="ns-limit m-fade">あと {left.toLocaleString('en-US')} 字</p>
              ) : null}
            </section>

            <section className="ns-sec">
              <button type="button" className={`sumrow ${adv ? 'open' : ''}`} aria-expanded={adv} aria-controls={advId} onClick={() => setAdv((v) => !v)}>
                <span className="sumrow-text">
                  <b>詳しい設定</b>
                  {summary.length > 0 && <small>{summary.join(' · ')}</small>}
                </span>
                <span className="chev" aria-hidden="true">
                  ›
                </span>
              </button>
              <div id={advId}>
                {advShown.map((x) => (
                  <Fold key={x.key} phase={x.phase}>
                    <div className="adv">
                      {ccAdv.map((c) => (
                        <Fold key={c.key} phase={c.phase}>
                          <Group label="権限モード" grid>
                            {PERMISSION_OPTIONS.map((v) => (
                              <Choice key={v} small value={v} checked={permissionMode === v} onPick={() => setPermissionMode(v)} title={permissionName(v)} danger={v === 'bypassPermissions'} />
                            ))}
                          </Group>
                          <Group label="モデル" grid>
                            {MODEL_OPTIONS.map((m) => (
                              <Choice key={m} small value={m} checked={model === m} onPick={() => setModel(m)} title={m || DEFAULT_LABEL} />
                            ))}
                          </Group>
                          {canEffort && (
                            <Group label="effort" grid>
                              {EFFORT_OPTIONS.map((v) => (
                                <Choice key={v} small value={v} checked={effort === v} onPick={() => setEffort(v)} title={v || DEFAULT_LABEL} />
                              ))}
                            </Group>
                          )}
                          {noteShown.map((n) => (
                            <div key={n.key} className={`fold ${phaseClass(n.phase)}`} aria-hidden={n.phase === 'leave' ? true : undefined}>
                              <div className="fold-in">
                                <p className="strip warn adv-note" role="note">
                                  xhigh と max は考える時間が長く、使用量が増えます。
                                </p>
                              </div>
                            </div>
                          ))}
                        </Fold>
                      ))}
                      {ocAdv.map((o) => (
                        <Fold key={o.key} phase={o.phase}>
                          <Group label="モード" grid>
                            <Choice small value="" checked={ocModeSent === ''} onPick={() => setOcMode('')} title={DEFAULT_LABEL} />
                            <Options
                              items={ocModes}
                              keyOf={(m) => m.id}
                              render={(m) => <Choice small value={m.id} checked={ocModeSent === m.id} onPick={() => setOcMode(m.id)} title={m.id} />}
                            />
                          </Group>
                          <Group label="モデル" grid={2} hint={ocHint}>
                            <Choice small stack value="" checked={ocModelSent === ''} onPick={() => setOcModel('')} title={DEFAULT_LABEL} sub={ocList?.defaultModel ?? undefined} />
                            <Options
                              items={ocModels}
                              keyOf={(m) => m.id}
                              render={(m) => <Choice small stack value={m.id} checked={ocModelSent === m.id} onPick={() => setOcModel(m.id)} title={m.label} sub={modelSub(m)} />}
                            />
                          </Group>
                          <Group label="自動承認" grid={2}>
                            <Choice small value="off" checked={!ocAuto} onPick={() => setOcAuto(false)} title="オフ" />
                            <Choice small value="on" checked={ocAuto} onPick={() => setOcAuto(true)} title="オン（--auto）" danger />
                          </Group>
                          {autoNote.map((n) => (
                            <div key={n.key} className={`fold ${phaseClass(n.phase)}`} aria-hidden={n.phase === 'leave' ? true : undefined}>
                              <div className="fold-in">
                                {n.key === 'on' ? (
                                  <p className="strip danger adv-note" role="note">
                                    deny 以外をすべて許可
                                  </p>
                                ) : (
                                  <p className="ns-hint adv-note">ask のツールは実行前に確認</p>
                                )}
                              </div>
                            </div>
                          ))}
                        </Fold>
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

/** 選択肢の組。grid は 3 列の札（true）か 2 列の札（2）、省けば縦の並び。 */
function Group({ label, hint, grid, children }: { label: string; hint?: string | null; grid?: boolean | 2; children: ReactNode }): ReactNode {
  const id = useId();
  return (
    <section className="ns-sec">
      <h2 className="ns-h" id={id}>
        {label}
      </h2>
      {hint && <p className="ns-hint m-fade">{hint}</p>}
      <div role="radiogroup" aria-labelledby={id} className={grid === 2 ? 'ns-grid' : grid ? 'ns-grid c3' : 'ns-list'}>
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
