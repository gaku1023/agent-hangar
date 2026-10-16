import type { PairingBlob } from '@agent-hangar/shared/src/mobileCrypto.ts';
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { JoinError, joinPhone, readPairText } from '../api.ts';
import { savePairing, type Pairing } from '../store.ts';

type Step =
  | { kind: 'start'; note: string | null }
  | { kind: 'confirm'; text: string; blob: PairingBlob }
  | { kind: 'joined'; pairing: Pairing; key: CryptoKey }
  | { kind: 'ticket' };

const BAD_TEXT = '接続の文字列が読めません。PC の QR の下の「文字列をコピー」で写し直してください。';

/** スマホの名前の既定。PC の一覧に出るので、機種の種類だけにする。 */
export function guessDeviceName(ua: string = navigator.userAgent): string {
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Android/.test(ua)) return 'Android';
  return 'スマホ';
}

/** ホーム画面から開いたアプリとして動いているか。 */
function standalone(): boolean {
  try {
    return window.matchMedia?.('(display-mode: standalone)').matches === true || (navigator as Navigator & { standalone?: boolean }).standalone === true;
  } catch {
    return false;
  }
}

function initialStep(pairText: string | null): Step {
  if (!pairText) return { kind: 'start', note: null };
  try {
    return { kind: 'confirm', text: pairText, blob: readPairText(pairText) };
  } catch {
    return { kind: 'start', note: BAD_TEXT };
  }
}

const joinMessage = (e: unknown): string => {
  if (!(e instanceof JoinError)) return `接続できませんでした（${e instanceof Error ? e.message : '不明'}）。もう一度押してください。`;
  switch (e.reason) {
    case 'storage':
      return 'このブラウザに鍵を置けませんでした。プライベートブラウズを切ってから、もう一度押してください（この QR はまだ使えます）。';
    case 'too-many-phones':
      return 'スマホは 10 台まで接続できます。PC の設定 › クラウド で使っていないスマホを外してから、QR を出し直してください。';
    case 'upgrade':
      return 'このアプリが古くなっています。いったん閉じて、開き直してください。';
    case 'network':
      return '接続先に届きませんでした。通信を確かめて、もう一度押してください。';
    default:
      return `接続できませんでした（${e.status ?? '不明'}）。少し待ってから、もう一度押してください。`;
  }
};

type Props = {
  /** 開いた URL の #pair= の中身（main が URL から消して渡す）。無ければ null。 */
  pairText: string | null;
  /** 接続を終えて受信箱へ進む。 */
  onEnter: (pairing: Pairing, key: CryptoKey) => void;
};

/** 参加の画面（画面のメモの C1 の ①〜④）。段が替わるたびに薄れから現す。 */
export function JoinScreen({ pairText, onEnter }: Props): ReactNode {
  const [step, setStep] = useState<Step>(() => initialStep(pairText));

  const onJoined = (pairing: Pairing, key: CryptoKey): void => {
    // ホーム画面のアプリの中で接続したなら、ホーム画面に追加する案内は要らない。
    if (standalone()) onEnter(pairing, key);
    else setStep({ kind: 'joined', pairing, key });
  };
  const onText = (text: string): string | null => {
    try {
      setStep({ kind: 'confirm', text, blob: readPairText(text) });
      return null;
    } catch {
      return BAD_TEXT;
    }
  };

  return (
    <main className="join">
      <div className="step m-fade" key={step.kind}>
        {step.kind === 'confirm' && <Confirm text={step.text} blob={step.blob} onJoined={onJoined} onTicket={() => setStep({ kind: 'ticket' })} />}
        {step.kind === 'joined' && <Joined onLater={() => onEnter(step.pairing, step.key)} />}
        {step.kind === 'ticket' && (
          <>
            <Logo />
            <h1 className="p-h">この QR は使えません</h1>
            <p className="strip danger m-fade">5 分を過ぎたか、すでに使われた QR です。PC の設定 › クラウド で、QR を出し直してください。</p>
            <ReadControls onText={onText} />
          </>
        )}
        {step.kind === 'start' && (
          <>
            <Logo />
            <h1 className="p-h">このスマホはまだ接続していません</h1>
            <p className="p-t">ホーム画面から開くと、Safari で接続した情報が引き継がれないことがあります。PC で新しい QR を出して、このアプリのまま読み込んでください。</p>
            {step.note && <p className="strip danger m-fade">{step.note}</p>}
            <ReadControls onText={onText} />
          </>
        )}
      </div>
    </main>
  );
}

function Logo(): ReactNode {
  return (
    <div className="p-logo">
      <i aria-hidden="true" />
      hangar
    </div>
  );
}

function useNow(everyMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(t);
  }, [everyMs]);
  return now;
}

function remaining(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** ① QR を読んだ直後の 1 枚。どこへ、どの PC の QR で、残り何分かを見てから押す。 */
function Confirm({ text, blob, onJoined, onTicket }: { text: string; blob: PairingBlob; onJoined: (p: Pairing, k: CryptoKey) => void; onTicket: () => void }): ReactNode {
  const [name, setName] = useState(() => guessDeviceName());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const now = useNow(1000);
  const host = new URL(blob.url).host;

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (busy) return;
    const n = name.trim();
    if (!n) {
      setError('スマホの名前を入れてください。');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { pairing, key } = await joinPhone(text, n);
      savePairing(pairing);
      onJoined(pairing, key);
    } catch (err) {
      if (err instanceof JoinError && err.reason === 'ticket') {
        onTicket();
        return;
      }
      setError(joinMessage(err));
      setBusy(false);
    }
  };

  return (
    <form className="join-form" onSubmit={(e) => void submit(e)}>
      <Logo />
      <h1 className="p-h">このスマホを hangar に接続する</h1>
      <div className="card">
        <div className="dest-l">接続先</div>
        <div className="dest-h">{host}</div>
        <p className="p-mini dest-from">
          QR を出した PC：{blob.pcName || '不明'} · 残り {remaining(blob.expiresAt - now)}
        </p>
      </div>
      <label className="field">
        このスマホの名前（PC の一覧に出ます）
        <input className="input" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} autoComplete="off" />
      </label>
      {error && (
        <p className="strip danger m-fade" role="alert" key={error}>
          {error}
        </p>
      )}
      <div className="p-spacer" />
      <p className="p-mini">接続すると、全部の PC の会話の一覧が見え、PC を選んで会話を始められます。スマホをなくしたら PC の設定から外してください。</p>
      <button type="submit" className="p-btn" disabled={busy}>
        {busy ? '接続しています…' : '接続する'}
      </button>
    </form>
  );
}

/** ② 接続した後。ホーム画面に追加する手順を見せる。 */
function Joined({ onLater }: { onLater: () => void }): ReactNode {
  const android = /Android/.test(navigator.userAgent);
  return (
    <>
      <div className="ok-big" aria-hidden="true">
        <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
          <path d="M5 12.5l4.5 4.5L19 7.5" />
        </svg>
      </div>
      <h1 className="p-h">接続しました</h1>
      <p className="p-t">最後に、ホーム画面に追加するとアプリのように開けます。</p>
      <div className="card">
        <ol className="steps">
          {android ? (
            <li>右上の ⋮ を押す</li>
          ) : (
            <li>
              下の
              <svg className="share" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-label="共有">
                <path d="M12 3v12M7 8l5-5 5 5" />
                <rect x="5" y="11" width="14" height="10" rx="2" />
              </svg>
              共有を押す
            </li>
          )}
          <li>「ホーム画面に追加」を選ぶ</li>
          <li>ホーム画面の hangar から開く</li>
        </ol>
      </div>
      <div className="p-spacer" />
      <button type="button" className="p-btn sec" onClick={onLater}>
        あとで（このまま受信箱へ）
      </button>
    </>
  );
}

/** ④ の読み取り。アプリの中のカメラで QR を読むか、接続の文字列を貼る。 */
function ReadControls({ onText }: { onText: (text: string) => string | null }): ReactNode {
  const [scanning, setScanning] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [pasted, setPasted] = useState('');
  const video = useRef<HTMLVideoElement>(null);
  const abort = useRef<AbortController | null>(null);
  // 親が描き直すたびに読み取りをやり直さないよう、受け手は ref で持つ。
  const onTextRef = useRef(onText);
  onTextRef.current = onText;

  useEffect(() => () => abort.current?.abort(), []);

  useEffect(() => {
    if (!scanning || !video.current) return;
    const ctl = new AbortController();
    abort.current = ctl;
    // jsQR は大きいので、カメラで読むと決めたときだけ読み込む。
    const el = video.current;
    import('../scanQr.ts').then(({ scanQr }) => scanQr(el, ctl.signal)).then(
      (text) => {
        if (ctl.signal.aborted) return;
        setScanning(false);
        const bad = onTextRef.current(text);
        if (bad) setNote(bad);
      },
      (e: unknown) => {
        if (ctl.signal.aborted || (e instanceof DOMException && e.name === 'AbortError')) return;
        setScanning(false);
        setNote('カメラを使えませんでした。設定でこのサイトにカメラを許すか、下の「接続の文字列を貼る」を使ってください。');
      },
    );
    return () => ctl.abort();
  }, [scanning]);

  const submitPaste = (e: FormEvent): void => {
    e.preventDefault();
    setNote(onText(pasted));
  };

  return (
    <div className="read">
      {scanning ? (
        <div className="scan m-fade">
          <video ref={video} className="scan-video" playsInline muted />
          <button type="button" className="p-btn sec" onClick={() => setScanning(false)}>
            やめる
          </button>
        </div>
      ) : (
        <button
          type="button"
          className="p-btn"
          onClick={() => {
            setNote(null);
            setScanning(true);
          }}
        >
          カメラで QR を読む
        </button>
      )}
      {note && (
        <p className="strip danger m-fade" role="alert" key={note}>
          {note}
        </p>
      )}
      <details className="p-more">
        <summary>読めないとき：接続の文字列を貼る</summary>
        <form className="paste" onSubmit={submitPaste}>
          <textarea className="input paste-text" aria-label="接続の文字列" placeholder="PC の QR の下にある「文字列をコピー」で写したもの" value={pasted} onChange={(e) => setPasted(e.target.value)} />
          <button type="submit" className="p-btn sec" disabled={!pasted.trim()}>
            文字列を読む
          </button>
        </form>
      </details>
    </div>
  );
}
