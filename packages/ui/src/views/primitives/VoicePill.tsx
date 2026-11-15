import type { VoiceStateDto } from '@agent-hangar/shared';
import { useEffect, useLayoutEffect, useRef } from 'react';
import { Icon } from './Icon.tsx';
import { useT } from './language.tsx';
import { collapseOut, growIn } from './motionKit.ts';
import { usePresence } from './usePresence.ts';

/** これより短く離したら toggle、押し続けたら hold。 */
export const HOLD_MS = 350;

type PillApi = { voiceHold(on: boolean): Promise<unknown>; voiceToggle(on: boolean): Promise<unknown> };

/**
 * 統括の声の丸（試作 A、docs/design.md「机の音声」）。補助が使えるときに MicButton の代わりに出す。
 * 短く押すと toggle の on と off、押し続けると hold（離すと off）。
 * 状態は data-phase で見せる（切、周りの声、聞いている、窓、会議）。聞き取った文は丸が左へ伸びて字幕になり、送ったあとは縮む帯が付く。
 * 伸びと縮みは motionKit の growIn と collapseOut（x）。モデルを落としている間は縁を進みで満たす（文字は出さない）。
 */
export function VoicePill(props: { state: VoiceStateDto; api: PillApi }) {
  const { state, api } = props;
  const t = useT();
  const apiRef = useRef(api);
  apiRef.current = api;
  const stateRef = useRef(state);
  stateRef.current = state;
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const held = useRef(false);
  const down = useRef(false);

  const release = () => {
    if (!down.current) return;
    down.current = false;
    clearTimeout(timer.current);
    if (held.current) { held.current = false; void apiRef.current.voiceHold(false).catch(() => {}); }
    else void apiRef.current.voiceToggle(stateRef.current.mode !== 'toggle').catch(() => {});
  };
  const press = () => {
    down.current = true;
    held.current = false;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => { held.current = true; void apiRef.current.voiceHold(true).catch(() => {}); }, HOLD_MS);
  };
  useEffect(() => () => {
    clearTimeout(timer.current);
    if (held.current) void apiRef.current.voiceHold(false).catch(() => {});
  }, []);

  // 字幕。出るときは右端を支点に左へ伸び、消えるときは縮む。縮む間は最後の文を残す。
  const caption = state.caption;
  const last = useRef('');
  if (caption !== null) last.current = caption;
  const presence = usePresence<HTMLSpanElement>(caption !== null, (el) => collapseOut(el, 'x'));
  const was = useRef(false);
  useLayoutEffect(() => {
    if (presence.mounted && !was.current && presence.ref.current) growIn(presence.ref.current, 'x');
    was.current = presence.mounted;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [presence.mounted]);

  const preparing = state.models.state === 'downloading' || state.models.state === 'loading';
  const sending = caption !== null && state.phase !== 'listening';
  return (
    <span className="vp">
      {presence.mounted && (
        <span ref={presence.ref} className="vp-pill" data-sending={sending ? 'true' : undefined} data-leaving={presence.leaving ? 'true' : undefined} aria-hidden="true">
          <span className="vp-txt"><span>{caption ?? last.current}</span></span>
          {sending && <span className="vp-bar"><b /></span>}
        </span>
      )}
      <button type="button" className="vp-btn" data-phase={state.phase} data-preparing={preparing ? 'true' : undefined}
        style={preparing ? ({ '--vp-progress': String(state.models.progress) } as React.CSSProperties) : undefined}
        aria-label={t('primitives.micButton.label')} aria-pressed={state.mode === 'toggle'} aria-busy={preparing || undefined}
        onPointerDown={press} onPointerUp={release} onPointerCancel={release} onPointerLeave={release}
        onClick={(e) => { if (e.detail === 0) void api.voiceToggle(state.mode !== 'toggle').catch(() => {}); }}>
        <Icon name="mic" />
      </button>
    </span>
  );
}
