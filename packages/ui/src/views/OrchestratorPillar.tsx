import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useEmit } from '../action/chain.tsx';
import type { ApprovalRowView, OrchestratorPillarProps } from '../presenters/orchestrator.ts';
import { createSpeaker } from '../voice/speaker.ts';
import type { VoicePort } from '../voice/voicePort.ts';
import { webVoicePort } from '../voice/webVoicePort.ts';
import { isComposing } from './ime.ts';
import { PeerChatLog } from './PeerChatLog.tsx';
import { Icon } from './primitives/Icon.tsx';
import { MicButton } from './primitives/MicButton.tsx';
import { useLanguage, useT } from './primitives/language.tsx';
import { collapseOut, fadeIn, growIn } from './primitives/motionKit.ts';
import { useMotionList } from './primitives/useMotionList.ts';
import { usePresence } from './primitives/usePresence.ts';

const OPEN_KEY = 'hangar.orchestrator.open';
const readOpen = (): boolean => { try { return localStorage.getItem(OPEN_KEY) === '1'; } catch { return false; } };
const writeOpen = (open: boolean): void => { try { localStorage.setItem(OPEN_KEY, open ? '1' : '0'); } catch { /* 保存できなくても動く */ } };

/** 画面で 1 つ使い回す音声の口。 */
let sharedPort: VoicePort | null = null;
const defaultPort = (): VoicePort => (sharedPort ??= webVoicePort());

/**
 * 統括の柱（案 A、docs/design.md「統括」）。窓の右端に、いつも同じ場所にある。
 * 畳むと丸 1 つ（統括の状態の色）。開くと、上に方針の 1 行と自動許可の記録、下に統括との会話と入力欄を置く。入力欄の右にマイク。
 * 開き閉じは幅の伸び縮み（growIn と collapseOut の x）で、丸と柱の入れ替えは usePresence を通る。
 * 見出しや説明の文は置かない。方針の下に並ぶ記録が「方針で通したもの」で、会話の列が「聞かれたもの」である。
 */
export function OrchestratorPillar(props: { orch: OrchestratorPillarProps; port?: VoicePort; defaultOpen?: boolean }) {
  const { orch } = props;
  const t = useT();
  const emit = useEmit();
  const language = useLanguage();
  const port = useMemo(() => props.port ?? defaultPort(), [props.port]);
  const speaker = useMemo(() => createSpeaker(port, () => language), [port, language]);
  const langRef = useRef(language);
  langRef.current = language;
  const [open, setOpen] = useState(() => props.defaultOpen ?? readOpen());
  const presence = usePresence<HTMLElement>(open, (el) => collapseOut(el, 'x'));
  const dot = useRef<HTMLButtonElement>(null);
  const [speakingKey, setSpeakingKey] = useState<string | null>(null);
  const micUsed = useRef(false);

  // 会話と記録の読み込み。柱が出たとき（読み上げは畳んでいても要る）と、開くたびに頼む。
  useEffect(() => { emit({ type: 'orchestrator.open' }); }, [emit, open]);
  const toggle = (next: boolean) => { setOpen(next); writeOpen(next); };

  // 丸が戻るときは薄れて現れる。
  const wasMounted = useRef(presence.mounted);
  useLayoutEffect(() => {
    if (wasMounted.current && !presence.mounted && dot.current) fadeIn(dot.current);
    wasMounted.current = presence.mounted;
  }, [presence.mounted]);
  // 柱は幅を伸ばして入る。最初の描画（開いたまま始まる）は動かさない。
  const first = useRef(true);
  useLayoutEffect(() => {
    if (first.current) { first.current = false; return; }
    if (open && presence.ref.current) growIn(presence.ref.current, 'x');
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
    const id = setInterval(() => { if (!port.speaking()) setSpeakingKey(null); }, 300);
    return () => clearInterval(id);
  }, [speakingKey, port]);
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => { if (e.key === 'Escape') { speaker.stop(); setSpeakingKey(null); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [speaker]);

  const send = (text: string) => { speaker.stop(); setSpeakingKey(null); emit({ type: 'orchestrator.send', text }); };
  const rows = speakingKey === null ? orch.rows : orch.rows.map((r) => (r.kind === 'assistant' && r.key === speakingKey ? { ...r, speaking: true } : r));

  return (
    <aside className="orch" data-open={open ? 'true' : undefined}>
      {!presence.mounted && (
        <button ref={dot} type="button" className="orch-dot" data-tone={orch.tone} aria-label={t('orchestratorPane.pillar.open')} title={orch.statusLabel} onClick={() => toggle(true)} />
      )}
      {presence.mounted && (
        <section ref={presence.ref} className="orch-panel" aria-label={t('orchestratorPane.pillar.region')} data-leaving={presence.leaving ? 'true' : undefined}>
          <div className="orch-top">
            {orch.policy !== null && <span className="orch-policy">{orch.policy}</span>}
            <button type="button" className="orch-dot orch-dot-close" data-tone={orch.tone} aria-label={t('orchestratorPane.pillar.close')} title={orch.statusLabel} onClick={() => toggle(false)} />
          </div>
          <Approvals rows={orch.approvals} />
          <PeerChatLog rows={rows} loading={orch.loading} quietEmpty label={t('orchestratorPane.log.label')} onCancel={() => {}} onAnswer={() => {}} />
          <Composer canSend={orch.canSend} sending={orch.sending} port={port} onSend={send} onMic={() => { micUsed.current = true; }} />
        </section>
      )}
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

/** 入力欄。右端にマイクと送るボタン。聞いている間は途中の文が欄に流れ、確定すると [voice] を付けて送る。 */
function Composer(props: { canSend: boolean; sending: boolean; port: VoicePort; onSend: (text: string) => void; onMic: () => void }) {
  const t = useT();
  const [text, setText] = useState('');
  const ta = useRef<HTMLTextAreaElement>(null);
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
        {props.canSend && <MicButton port={props.port} onInterim={setText} onSend={(s) => { props.onMic(); props.onSend(s); }} />}
        <button type="button" className="pchat-send" disabled={!ready} aria-label={t('orchestratorPane.composer.send')} onClick={submit}><Icon name="seeAll" /></button>
      </div>
    </div>
  );
}
