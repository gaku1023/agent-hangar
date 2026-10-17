import type { PairingBlob } from '@agent-hangar/shared/src/mobileCrypto.ts';
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { remaining, useNow } from '../countdown.ts';
import { isStandalone } from '../platform.ts';
import { JoinError, joinPhone, readPairText, UnpairedError, type UnpairedReason } from '../api.ts';
import { waitPhoneKeys } from '../keyring.ts';
import { clearPairing, savePairing, type Keyring, type Pairing, type PhonePair } from '../store.ts';

type Step =
  | { kind: 'start'; note: string | null; expired: boolean }
  | { kind: 'confirm'; text: string; blob: PairingBlob }
  | { kind: 'waiting'; pairing: Pairing; pair: PhonePair; pcName: string | null }
  | { kind: 'joined'; pairing: Pairing; pair: PhonePair; keys: Keyring }
  | { kind: 'ticket' };

const BAD_TEXT = '接続コードを読み取れません。PC の QR の下の「コードをコピー」でコピーし直してください。';
/** 30 日使わなかったか、接続から 90 日たって、Worker がトークンを断った。 */
export const EXPIRED_TEXT = '接続の期限が切れました。PC で QR を出して接続し直してください。';
const UNPAIRED_TEXT = 'このスマホの接続は解除されています。PC で QR を表示して、接続し直してください。';

/** 401 で参加の画面に戻ったときの文。 */
const unpairedNote = (reason: UnpairedReason): string => (reason === 'expired' ? EXPIRED_TEXT : UNPAIRED_TEXT);

/** スマホの名前の既定。PC の一覧に出るので、機種の種類だけにする。 */
export function guessDeviceName(ua: string = navigator.userAgent): string {
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Android/.test(ua)) return 'Android';
  return 'スマホ';
}

function initialStep(pairText: string | null, notice: 'expired' | null, resume: Resume | null): Step {
  if (resume && !pairText) return { kind: 'waiting', pairing: resume.pairing, pair: resume.pair, pcName: null };
  if (!pairText) return { kind: 'start', note: notice === 'expired' ? EXPIRED_TEXT : null, expired: notice === 'expired' };
  try {
    return { kind: 'confirm', text: pairText, blob: readPairText(pairText) };
  } catch {
    return { kind: 'start', note: BAD_TEXT, expired: false };
  }
}

const joinMessage = (e: unknown): string => {
  if (!(e instanceof JoinError)) return `接続できませんでした（${e instanceof Error ? e.message : '不明'}）。もう一度タップしてください。`;
  switch (e.reason) {
    case 'storage':
      return 'このブラウザにキーを保存できませんでした。プライベートブラウズを切ってから、もう一度タップしてください（この QR はまだ使えます）。';
    case 'too-many-phones':
      return 'スマホは 10 台まで接続できます。PC の設定 › クラウド同期 で使っていないスマホを解除してから、QR を表示し直してください。';
    case 'upgrade':
      return 'このアプリが古くなっています。いったん閉じて、開き直してください。';
    case 'network':
      return '接続先と通信できませんでした。通信を確認して、もう一度タップしてください。';
    default:
      return `接続できませんでした（${e.status ?? '不明'}）。少し待ってから、もう一度タップしてください。`;
  }
};

/** 接続はできたが、スマホ用の鍵をまだ受け取っていない（keybox を待っている間にアプリを閉じた）。 */
export type Resume = { pairing: Pairing; pair: PhonePair };

type Props = {
  /** 開いた URL の #pair= の中身（main が URL から消して渡す）。無ければ null。 */
  pairText: string | null;
  /** 接続を終えて受信箱へ進む。 */
  onEnter: (pairing: Pairing, pair: PhonePair, keys: Keyring) => void;
  /** 受信箱が 401 expired で戻ってきた。期限切れの文を出す。 */
  notice?: 'expired' | null;
  /** keybox の待ちから続ける。 */
  resume?: Resume | null;
  /** keybox を読む間隔と、待つ長さ。試験で縮める。 */
  wait?: { everyMs?: number; giveUpMs?: number };
};

/** 参加の画面（画面のメモの C1 の ①〜④）。段が替わるたびに薄れから現す。 */
export function JoinScreen({ pairText, onEnter, notice = null, resume = null, wait }: Props): ReactNode {
  const [step, setStep] = useState<Step>(() => initialStep(pairText, notice, resume));
  // ホーム画面のアプリでは、接続の画面を開いたらすぐカメラで QR を読む。
  const [home] = useState(isStandalone);

  const onJoined = (pairing: Pairing, pair: PhonePair, keys: Keyring): void => {
    // ホーム画面のアプリの中で接続したなら、ホーム画面に追加する案内は要らない。
    if (isStandalone()) onEnter(pairing, pair, keys);
    else setStep({ kind: 'joined', pairing, pair, keys });
  };
  const onUnpaired = (reason: UnpairedReason): void => {
    void clearPairing();
    setStep({ kind: 'start', note: unpairedNote(reason), expired: reason === 'expired' });
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
        {step.kind === 'confirm' && (
          <Confirm
            text={step.text}
            blob={step.blob}
            onWaiting={(pairing, pair) => setStep({ kind: 'waiting', pairing, pair, pcName: step.blob.pcName || null })}
            onTicket={() => setStep({ kind: 'ticket' })}
          />
        )}
        {step.kind === 'waiting' && (
          <Waiting
            pairing={step.pairing}
            pair={step.pair}
            pcName={step.pcName}
            wait={wait}
            onKeys={(keys) => onJoined(step.pairing, step.pair, keys)}
            onUnpaired={onUnpaired}
            onGiveUp={() => {
              void clearPairing();
              setStep({ kind: 'start', note: null, expired: false });
            }}
          />
        )}
        {step.kind === 'joined' && <Joined onLater={() => onEnter(step.pairing, step.pair, step.keys)} />}
        {step.kind === 'ticket' && (
          <>
            <Logo />
            <h1 className="p-h">この QR は使えません</h1>
            <p className="strip danger m-fade">5 分を過ぎたか、すでに使われた QR です。PC の設定 › クラウド同期 で、QR を表示し直してください。</p>
            <ReadControls onText={onText} />
          </>
        )}
        {step.kind === 'start' && (
          <>
            <Logo />
            {home ? (
              <>
                <span className="ctx home">ホーム画面アプリ</span>
                <h1 className="p-h">PC の QR を読み取ります</h1>
                <p className="p-t">PC の画面の QR を枠に合わせてください。QR は PC で表示してから 5 分有効です。</p>
              </>
            ) : step.expired ? (
              <h1 className="p-h">このスマホの接続が切れています</h1>
            ) : (
              <>
                <h1 className="p-h">このスマホはまだ接続していません</h1>
                <p className="p-t">ホーム画面から開くと、Safari で接続した情報が引き継がれないことがあります。PC で新しい QR を表示して、このアプリのまま読み込んでください。</p>
              </>
            )}
            {step.note && <p className="strip danger m-fade">{step.note}</p>}
            <ReadControls onText={onText} autoScan={home} />
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

/** ① QR を読んだ直後の 1 枚。どこへ、どの PC の QR で、残り何分かを見てから押す。 */
function Confirm({ text, blob, onWaiting, onTicket }: { text: string; blob: PairingBlob; onWaiting: (p: Pairing, pair: PhonePair) => void; onTicket: () => void }): ReactNode {
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
      setError('スマホの名前を入力してください。');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // 接続できたら、スマホ用の鍵を受け取る前に接続を置く（待っている間に閉じても、開き直して待ちから続けられる）。
      const { pairing, pair } = await joinPhone(text, n);
      savePairing(pairing);
      onWaiting(pairing, pair);
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
          QR を表示した PC：{blob.pcName || '不明'} · 残り {remaining(blob.expiresAt - now)}
        </p>
      </div>
      <label className="field">
        このスマホの名前（PC の一覧に表示されます）
        <input className="input" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} autoComplete="off" />
      </label>
      {error && (
        <p className="strip danger m-fade" role="alert" key={error}>
          {error}
        </p>
      )}
      <div className="p-spacer" />
      <p className="p-mini">接続すると、すべての PC の会話の一覧を確認でき、PC を選んで会話を開始できます。スマホをなくしたら、PC の設定で接続を解除してください。</p>
      <button type="submit" className="p-btn" disabled={busy}>
        {busy ? '接続中…' : '接続する'}
      </button>
    </form>
  );
}

/**
 * ①と②の間。接続はできたので、QR を表示した PC がこのスマホ用のキー（M）を keybox に置くのを待つ。
 * 2 秒ごとに最大 60 秒。待ちきれなければ理由を出し、「もう一度待つ」で券を使わずに待ち直す。
 */
function Waiting({
  pairing,
  pair,
  pcName,
  wait,
  onKeys,
  onUnpaired,
  onGiveUp,
}: {
  pairing: Pairing;
  pair: PhonePair;
  pcName: string | null;
  wait?: { everyMs?: number; giveUpMs?: number };
  onKeys: (keys: Keyring) => void;
  onUnpaired: (reason: UnpairedReason) => void;
  onGiveUp: () => void;
}): ReactNode {
  const [round, setRound] = useState(0);
  const [failed, setFailed] = useState(false);
  // 親が描き直すたびに待ちをやり直さないよう、受け手は ref で持つ。
  const handlers = useRef({ onKeys, onUnpaired });
  handlers.current = { onKeys, onUnpaired };
  const waitRef = useRef(wait);
  waitRef.current = wait;

  useEffect(() => {
    const ctl = new AbortController();
    setFailed(false);
    waitPhoneKeys(pairing, pair, { ...waitRef.current, signal: ctl.signal }).then(
      (keys) => {
        if (!ctl.signal.aborted) handlers.current.onKeys(keys);
      },
      (e: unknown) => {
        if (ctl.signal.aborted) return;
        if (e instanceof UnpairedError) handlers.current.onUnpaired(e.reason);
        else setFailed(true);
      },
    );
    return () => ctl.abort();
  }, [pairing, pair, round]);

  const pc = pcName ? `QR を表示した PC（${pcName}）` : 'QR を表示した PC';
  return (
    <>
      <Logo />
      <h1 className="p-h">PC の応答を待っています</h1>
      <p className="p-t">{pc}が、このスマホ用のキーを用意しています。PC の QR は表示したままにしてください。</p>
      {failed ? (
        <p className="strip danger m-fade" role="alert">
          PC から応答がありません。PC で hangar が実行中で、QR を表示したままか確認して、「もう一度待つ」をタップしてください。
        </p>
      ) : (
        <p className="p-mini m-fade" role="status">
          受信中…（最大 1 分）
        </p>
      )}
      <div className="p-spacer" />
      {failed && (
        <>
          <button type="button" className="p-btn" onClick={() => setRound((n) => n + 1)}>
            もう一度待つ
          </button>
          <button type="button" className="p-btn sec" onClick={onGiveUp}>
            別の QR で接続する
          </button>
          {/* 接続はできているので、Worker のスマホの行は PC で解除するまで消えない（10 台の枠にも数える）。 */}
          <p className="p-mini m-fade">別の QR で接続しても、今の接続は PC の設定 › クラウド同期 で解除するまで削除されません。</p>
        </>
      )}
    </>
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
            <li>右上の ⋮ をタップ</li>
          ) : (
            <li>
              下の
              <svg className="share" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-label="共有">
                <path d="M12 3v12M7 8l5-5 5 5" />
                <rect x="5" y="11" width="14" height="10" rx="2" />
              </svg>
              共有をタップ
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

/** ④ の読み取り。アプリの中のカメラで QR を読むか、接続コードを貼り付ける。 */
function ReadControls({ onText, autoScan = false }: { onText: (text: string) => string | null; autoScan?: boolean }): ReactNode {
  const [scanning, setScanning] = useState(autoScan);
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
        setNote('カメラを使えませんでした。設定でこのサイトにカメラを許可するか、下の「接続コードを貼り付け」を使ってください。');
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
            キャンセル
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
        <summary>読み取れないとき：接続コードを貼り付け</summary>
        <form className="paste" onSubmit={submitPaste}>
          <textarea className="input paste-text" aria-label="接続コード" placeholder="PC の QR の下の「コードをコピー」でコピーしたもの" value={pasted} onChange={(e) => setPasted(e.target.value)} />
          <button type="submit" className="p-btn sec" disabled={!pasted.trim()}>
            コードを読み取る
          </button>
        </form>
      </details>
    </div>
  );
}
