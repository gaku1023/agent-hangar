import { useEffect, useRef, useState } from 'react';
import { ECHO_GUARD_MS, SILENCE_MS, VOICE_TAG, type ListenSession, type VoicePort } from '../../voice/voicePort.ts';
import { Icon } from './Icon.tsx';
import { useLanguage, useT } from './language.tsx';

/**
 * 押して話すマイクのボタン（切り替え式）。押すと聞き始め、確定の文のあと 1.2 秒黙ると送る。
 * もう一度押すとそこまでを送り、Esc は捨てる。読み上げ中に押すと読み上げを止めて聞く。
 * 読み上げの間と直後 1.5 秒の認識は捨てる（自分の声を拾わないため）。
 * listen が使えない環境ではボタン自体を出さない。
 */
export function MicButton(props: { port: VoicePort; onSend: (text: string) => void; onInterim?: (text: string) => void }) {
  const { port } = props;
  const t = useT();
  const lang = useLanguage();
  const [on, setOn] = useState(false);
  const session = useRef<ListenSession | null>(null);
  const finals = useRef('');
  const interim = useRef('');
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const sent = useRef(false);
  const propsRef = useRef(props);
  propsRef.current = props;

  const text = () => `${finals.current}${interim.current}`.trim();
  const finish = (send: boolean) => {
    clearTimeout(timer.current);
    if (sent.current) return;
    sent.current = true;
    const s = session.current;
    session.current = null;
    const out = text();
    if (send) s?.stop(); else s?.abort();
    finals.current = '';
    interim.current = '';
    setOn(false);
    propsRef.current.onInterim?.('');
    if (send && out !== '') propsRef.current.onSend(`${VOICE_TAG} ${out}`);
  };
  const guarded = () => port.speaking() || Date.now() - port.lastSpokenEnd() < ECHO_GUARD_MS;
  const arm = () => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => finish(true), SILENCE_MS);
  };

  const start = () => {
    if (port.speaking()) port.cancel();
    sent.current = false;
    finals.current = '';
    interim.current = '';
    setOn(true);
    session.current = port.listen(lang, {
      onInterim: (s) => {
        if (guarded()) return;
        interim.current = s;
        propsRef.current.onInterim?.(text());
        arm();
      },
      onFinal: (s) => {
        if (guarded()) return;
        finals.current += s;
        interim.current = '';
        propsRef.current.onInterim?.(text());
        arm();
      },
      onEnd: () => finish(true),
      onError: () => finish(false),
    });
  };

  useEffect(() => {
    if (!on) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') finish(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // finish は ref だけを読むので、押している間は張り替えない。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [on]);
  useEffect(() => () => { clearTimeout(timer.current); session.current?.abort(); }, []);

  if (!port.canListen()) return null;
  return (
    <button type="button" className="mic-btn" data-on={on ? 'true' : undefined} aria-pressed={on} aria-label={t('primitives.micButton.label')} onClick={() => (on ? finish(true) : start())}>
      <Icon name="mic" />
    </button>
  );
}
