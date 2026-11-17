import type { OrchestratorOrigin, VoiceStateDto } from '@agent-hangar/shared';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useEmit } from '../action/chain.tsx';
import type { ApprovalRowView, OrchestratorPillarProps } from '../presenters/orchestrator.ts';
import { createApi } from '../runtime/api.ts';
import { hangarVoicePort } from '../voice/hangarVoicePort.ts';
import { createSpeaker } from '../voice/speaker.ts';
import type { VoicePort } from '../voice/voicePort.ts';
import { webVoicePort } from '../voice/webVoicePort.ts';
import { anywhereKeys, KEYMAP } from '../keys.ts';
import { isComposing } from './ime.ts';
import { ORCH_WIDTH_DEFAULT } from '../mediator/orchestrator.ts';
import { OrchestratorGrip } from './OrchestratorGrip.tsx';
import { PeerChatLog } from './PeerChatLog.tsx';
import { Icon } from './primitives/Icon.tsx';
import { MicButton } from './primitives/MicButton.tsx';
import { VoicePill } from './primitives/VoicePill.tsx';
import { useLanguage, useT } from './primitives/language.tsx';
import { collapseOut, fadeIn } from './primitives/motionKit.ts';
import { MenuButton, type MenuItem } from './primitives/MenuButton.tsx';
import type { PeerChatRow } from '../presenters/peerChat.ts';
import { pillarClose, pillarOpen } from './primitives/pillarMotion.ts';
import { useMotionList } from './primitives/useMotionList.ts';
import { usePresence } from './primitives/usePresence.ts';
import { setOrchestratorOpen, useOrchestratorOpen } from './orchestratorOpen.ts';


const ORCH_KEYS = KEYMAP.find((k) => k.id === 'orchestrator.toggle')!;

/** 画面で 1 つ使い回す音声の口。 */
let sharedPort: VoicePort | null = null;
const defaultPort = (): VoicePort => (sharedPort ??= webVoicePort());

/** 補助（hangar-voice）の口。補助が使えるとき（voice.available）だけ、Web Speech の代わりに使う。 */
type VoiceApi = Parameters<typeof hangarVoicePort>[0] & Parameters<typeof VoicePill>[0]['api'];
let sharedVoiceApi: VoiceApi | null = null;
const defaultVoiceApi = (): VoiceApi => (sharedVoiceApi ??= createApi());

/**
 * 統括の柱（案 A、docs/design.md「統括」）。窓の右端に、いつも同じ場所にある。
 * 畳むと丸 1 つ（統括の状態の色）。開くと、上に方針の 1 行と自動許可の記録、下に統括との会話と入力欄を置く。入力欄の右にマイク。
 * 開き閉じは外側の箱だけの幅の伸び縮み（pillarMotion.ts。中身は開いたときの幅のまま切り抜く）で、丸と柱の入れ替えは usePresence を通る。
 * 見出しや説明の文は置かない。方針の下に並ぶ記録が「方針で通したもの」で、会話の列が「聞かれたもの」である。
 */
export function OrchestratorPillar(props: { orch: OrchestratorPillarProps; port?: VoicePort; voiceApi?: VoiceApi; defaultOpen?: boolean; width?: number }) {
  const { orch } = props;
  const t = useT();
  const emit = useEmit();
  const language = useLanguage();
  const port = useMemo(() => props.port ?? defaultPort(), [props.port]);
  const voiceApi = useMemo(() => props.voiceApi ?? defaultVoiceApi(), [props.voiceApi]);
  const hangarPort = useMemo(() => hangarVoicePort(voiceApi), [voiceApi]);
  hangarPort.update(orch.voice ?? null);
  // 補助が使えるときは読み上げも補助へ（POST /api/voice/speak）。使えないときは今の Web Speech のまま。
  const helper = orch.voice?.available === true;
  const livePort = helper ? hangarPort : port;
  const speaker = useMemo(() => createSpeaker(livePort, () => language), [livePort, language]);
  const langRef = useRef(language);
  langRef.current = language;
  // 開閉はサイドバーの「統括」の行と共有する（orchestratorOpen.ts）。defaultOpen は最初の描画で 1 度だけ効く（覚えない）。
  useState(() => { if (props.defaultOpen !== undefined) setOrchestratorOpen(props.defaultOpen, false); });
  const open = useOrchestratorOpen();
  const presence = usePresence<HTMLElement>(open, (el) => pillarClose(el, el.firstElementChild as HTMLElement | null));
  const dot = useRef<HTMLButtonElement>(null);
  const [speakingKey, setSpeakingKey] = useState<string | null>(null);
  const micUsed = useRef(false);
  // 補助で聞いている間も、マイクを使ったとみなす（返答のあとの知らせを読む）。
  if (orch.voice?.phase === 'listening') micUsed.current = true;

  // 会話と記録の読み込み。柱が出たとき（読み上げは畳んでいても要る）と、開くたびに頼む。
  useEffect(() => { emit({ type: 'orchestrator.open' }); }, [emit, open]);
  // 柱の開閉を mediator へ写す（開いている間は、どの会話も右の欄を畳む）。
  useEffect(() => { emit({ type: 'orchestrator.pillar', open }); }, [emit, open]);
  const toggle = (next: boolean) => setOrchestratorOpen(next);

  // 丸が戻るときは薄れて現れる。
  const wasMounted = useRef(presence.mounted);
  useLayoutEffect(() => {
    if (wasMounted.current && !presence.mounted && dot.current) fadeIn(dot.current);
    wasMounted.current = presence.mounted;
  }, [presence.mounted]);
  // 柱は外側の箱の幅を伸ばして入る。最初の描画（開いたまま始まる）は動かさない。
  const first = useRef(true);
  useLayoutEffect(() => {
    if (first.current) { first.current = false; return; }
    if (open && presence.ref.current) void pillarOpen(presence.ref.current, presence.ref.current.firstElementChild as HTMLElement | null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // 読み上げ。読み込みが済んだ時点の分は読まない（古い返答を、開いただけで読まない）。
  const spoken = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (orch.loading) return;
    const { reply, notices, voiceOn } = orch.speak;
    if (spoken.current === null) {
      spoken.current = new Set([...(reply ? [reply.key] : []), ...notices.map((n) => n.key)]);
      return;
    }
    const done = spoken.current;
    const say = (s: { key: string; text: string }) => { done.add(s.key); speaker.speak(s.text); setSpeakingKey(s.key); };
    // 返答は、ターンが終わって（作業中でなくなって）から 1 度だけ読む。
    if (reply && !done.has(reply.key) && orch.tone !== 'busy') say(reply);
    if (voiceOn || micUsed.current) for (const n of notices) if (!done.has(n.key)) say(n);
  }, [orch.loading, orch.speak, orch.tone, speaker]);
  // 読み終えたら印を消す。
  useEffect(() => {
    if (speakingKey === null) return;
    const id = setInterval(() => { if (!livePort.speaking()) setSpeakingKey(null); }, 300);
    return () => clearInterval(id);
  }, [speakingKey, livePort]);
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => { if (e.key === 'Escape') { speaker.stop(); setSpeakingKey(null); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [speaker]);

  const send = (text: string, origin?: OrchestratorOrigin) => { speaker.stop(); setSpeakingKey(null); emit({ type: 'orchestrator.send', text, ...(origin !== undefined ? { origin } : {}) }); };
  const rows = speakingKey === null ? orch.rows : orch.rows.map((r) => (r.kind === 'assistant' && r.key === speakingKey ? { ...r, speaking: true } : r));

  // 柱のメニュー（右上の丸、試作 A）。頭に状態の行、項目は 会話を新しくする・停止か再開・統括を閉じる。
  const menuHead = <span className="orch-menu-status"><span className="orch-dot" data-tone={orch.tone} aria-hidden="true" />{orch.statusLabel}</span>;
  const busyNote = orch.keeper.switching ? orch.statusLabel : null;
  const menuItems: MenuItem[] = [
    { key: 'fresh', label: t('orchestratorPane.menu.fresh'), icon: 'restart', disabled: busyNote, quietReason: true, onSelect: () => emit({ type: 'orchestrator.control', op: 'fresh' }) },
    orch.keeper.stopped
      ? { key: 'wake', label: t('orchestratorPane.menu.wake'), icon: 'play', disabled: busyNote, quietReason: true, onSelect: () => emit({ type: 'orchestrator.control', op: 'wake' }) }
      : { key: 'stop', label: t('orchestratorPane.menu.stop'), icon: 'stop', disabled: busyNote, quietReason: true, onSelect: () => emit({ type: 'orchestrator.control', op: 'stop' }) },
    { key: 'close', label: t('orchestratorPane.pillar.close'), icon: 'paneClose', separatorBefore: true, onSelect: () => toggle(false) },
  ];

  // 新しい会話に切り替わったら、前の会話の行を畳み（collapseOut）、区切りの線（fadeIn）の下に新しい会話を積む。
  // 柱を開いている間だけの見せ方で、開き直せば区切りは無い（前の話は検索とその会話を開く操作で読む）。
  const [retired, setRetired] = useState<{ key: string; rows: PeerChatRow[] } | null>(null);
  const [switched, setSwitched] = useState(false);
  const lastId = useRef(orch.sessionId);
  const lastRows = useRef(orch.rows);
  useLayoutEffect(() => {
    if (lastId.current !== orch.sessionId) {
      if (presence.mounted && lastRows.current.length > 0) setRetired({ key: lastId.current, rows: lastRows.current });
      if (presence.mounted) setSwitched(true);
      lastId.current = orch.sessionId;
    }
    lastRows.current = orch.rows;
  }, [orch.sessionId, orch.rows, presence.mounted]);
  useEffect(() => { if (!presence.mounted) { setSwitched(false); setRetired(null); } }, [presence.mounted]);
  const divider = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => { if (switched && divider.current) fadeIn(divider.current); }, [switched]);

  return (
    <aside className="orch" data-open={open ? 'true' : undefined}>
      {!presence.mounted && (
        <button ref={dot} type="button" className="orch-dot" data-tone={orch.tone} data-phase={helper ? orch.voice?.phase : undefined} aria-label={t('orchestratorPane.pillar.open')} title={`${orch.statusLabel} ${anywhereKeys(ORCH_KEYS)}`} onClick={() => toggle(true)} />
      )}
      {presence.mounted && (
        <section ref={presence.ref} className="orch-panel" aria-label={t('orchestratorPane.pillar.region')} data-leaving={presence.leaving ? 'true' : undefined}>
          <div className="orch-panel-in">
          <div className="orch-top">
            {orch.policy !== null && <span className="orch-policy">{orch.policy}</span>}
            <kbd className="mono orch-keys">{anywhereKeys(ORCH_KEYS)}</kbd>
            <MenuButton label={t('orchestratorPane.menu.label')} faceClassName="orch-dot-close" title={orch.statusLabel} head={menuHead} items={menuItems}
              face={<><span className="orch-dot" data-tone={orch.tone} data-switching={orch.keeper.switching ? 'true' : undefined} aria-hidden="true" /><span className="sr-only">{t('orchestratorPane.menu.label')}</span></>} />
            {orch.context && (
              <div className="orch-context" role="img" aria-label={orch.context.label} title={orch.context.label} data-over={orch.context.over ? 'true' : undefined}>
                <i style={{ width: `${Math.round(orch.context.ratio * 1000) / 10}%` }} />
              </div>
            )}
          </div>
          <Approvals rows={orch.approvals} />
          <div className="orch-log">
            {retired && <Retired key={retired.key} rows={retired.rows} label={t('orchestratorPane.log.label')} onGone={() => setRetired(null)} />}
            {switched && <div ref={divider} role="separator" className="orch-divider" />}
            <PeerChatLog rows={rows} loading={orch.loading} quietEmpty label={t('orchestratorPane.log.label')} onCancel={() => {}} onAnswer={() => {}} />
          </div>
          <Composer canSend={orch.canSend} sending={orch.sending} port={port} voice={helper ? orch.voice! : null} voiceApi={voiceApi} onSend={send} onMic={() => { micUsed.current = true; }} />
          </div>
        </section>
      )}
      {open && <OrchestratorGrip width={props.width ?? ORCH_WIDTH_DEFAULT} />}
    </aside>
  );
}

/** 自動許可の記録。行は 会話の題名 / 道具 / 中身の先頭 で、押すとその会話へ移る。行の出入りは growIn と collapseOut（useMotionList）。 */
function Approvals({ rows }: { rows: ApprovalRowView[] }) {
  const t = useT();
  const emit = useEmit();
  const { list, ref } = useMotionList(rows, (r) => r.id, { enter: 'grow', enterFromEmpty: true, exitWhenEmpty: true });
  if (list.length === 0) return null;
  return (
    <ul className="orch-approvals" aria-label={t('orchestratorPane.approvals.label')}>
      {list.map((e) => (
        <li key={e.key} ref={ref(e.key)} data-leaving={e.leaving || undefined}>
          <button type="button" className="orch-approval" onClick={() => emit({ type: 'nav.go', to: { name: 'session', id: e.item.sessionId } })}>
            <span className="orch-approval-title">{e.item.title}</span>
            <span className="orch-approval-tool">{e.item.tool}</span>
            <span className="orch-approval-head">{e.item.head}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/** 入力欄。右端にマイクと送るボタン。聞いている間は途中の文が欄に流れ、確定すると由来 voice-held で送る（印はサーバが由来から付ける）。 */
function Composer(props: { canSend: boolean; sending: boolean; port: VoicePort; voice: VoiceStateDto | null; voiceApi: VoiceApi; onSend: (text: string, origin?: OrchestratorOrigin) => void; onMic: () => void }) {
  const t = useT();
  const [text, setText] = useState('');
  const ta = useRef<HTMLTextAreaElement>(null);
  const textRef = useRef(text);
  textRef.current = text;
  // マイクを押した時点の打ちかけ。聞いている間だけ持ち、聞き終えたら欄をこれに戻す。
  const draft = useRef<string | null>(null);
  const onInterim = (s: string) => {
    if (s === '') {
      if (draft.current !== null) setText(draft.current);
      draft.current = null;
      return;
    }
    draft.current ??= textRef.current;
    const d = draft.current;
    setText(d === '' || /\s$/.test(d) ? `${d}${s}` : `${d} ${s}`);
  };
  const ready = props.canSend && !props.sending && text.trim() !== '';
  const submit = () => {
    if (!ready) return;
    props.onSend(text.trim());
    setText('');
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !isComposing(e)) { e.preventDefault(); submit(); }
  };
  return (
    <div className="pchat-comp orch-comp">
      <div className="pchat-box" data-blocked={props.canSend ? undefined : 'true'}>
        <textarea ref={ta} rows={1} value={text} aria-label={t('orchestratorPane.composer.label')} placeholder={t('orchestratorPane.composer.placeholder')} disabled={!props.canSend}
          onChange={(e) => setText(e.target.value)} onKeyDown={onKeyDown} />
        {props.canSend && props.voice && <VoicePill state={props.voice} api={props.voiceApi} />}
        {props.canSend && !props.voice && <MicButton port={props.port} onInterim={onInterim} onSend={(s) => { props.onMic(); props.onSend(s, 'voice-held'); }} />}
        <button type="button" className="pchat-send" disabled={!ready} aria-label={t('orchestratorPane.composer.send')} onClick={submit}><Icon name="seeAll" /></button>
      </div>
    </div>
  );
}

/** 前の会話の行。出たとたんに高さを畳み（collapseOut）、畳み終えたら外れる。 */
function Retired(props: { rows: PeerChatRow[]; label: string; onGone: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  const gone = useRef(props.onGone);
  gone.current = props.onGone;
  useLayoutEffect(() => {
    if (!box.current) return;
    void collapseOut(box.current).then(() => gone.current());
  }, []);
  return (
    <div ref={box} className="orch-retired" aria-hidden="true">
      <PeerChatLog rows={props.rows} loading={false} quietEmpty label={props.label} onCancel={() => {}} onAnswer={() => {}} />
    </div>
  );
}
