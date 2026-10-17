import type { MobileLaunchAnswer, MobileLaunchPayload } from '@agent-hangar/shared/src/mobile.ts';
import { LaunchError } from './api.ts';
import { imageFailureText, ImageError, putImage as defaultPutImage, type LaunchImage, type PutImage } from './images.ts';
import { requestLaunch, waitLaunch, type LaunchStage } from './launch.ts';
import type { Pairing, PhoneKey } from './store.ts';

/** 新しい会話の依頼 1 件。画面（フォーム）が作り、起動のシートが進みを見せる。 */
export type LaunchSpec = {
  targetDevice: string;
  pcName: string;
  /** プロジェクトの名前。すぐ始める（フォルダなし）なら null。 */
  projectName: string | null;
  accountId: string;
  accountName: string | null;
  /** #rgb〜#rrggbbaa の形だけ。 */
  accountColor: string | null;
  /** 封じて送る中身。画像があれば images に控え（番号、種類、大きさ）を入れる。 */
  payload: Omit<MobileLaunchPayload, 'v' | 'createdAt'>;
  /** 受信箱の InboxView.skewMs。 */
  skewMs: number;
  /** 先に振った依頼の ID。欄で画像をこの ID の下に置いてあるとき、最初の送信はこの ID で出す。 */
  id?: string;
  /** 付けた画像の中身。依頼の ID が変わる送り直しでは、依頼の前にこれを新しい ID の下へ置き直す。 */
  images?: LaunchImage[];
};

/**
 * 依頼の進み。
 * - sending：Worker に置いている。
 * - waiting：Worker が受けた。claimed は PC が受け取ったか。
 * - started：会話が始まった。
 * - failed：始まらなかった。at は止まった段（send は送信、pc は PC の受け取りと始まり）。reconnect は接続し直しを勧める。
 * - unreadable、unanswered：始まったかもしれない。送り直させない（新しい id で二つ目の会話が起きうる）。
 * - unpaired：このスマホの接続が外された。
 */
export type RunState =
  | { kind: 'sending' }
  | { kind: 'waiting'; claimed: boolean }
  | { kind: 'started'; sessionId: string; title: string }
  | { kind: 'failed'; at: 'send' | 'pc'; message: string; detail?: string; reconnect?: boolean }
  | { kind: 'unreadable' }
  | { kind: 'unanswered' }
  | { kind: 'unpaired' };

export type LaunchRun = {
  /** 失敗した依頼をもう一度送る。失敗の段でなければ何もしない。 */
  retry: () => void;
  /** 読むのをやめる。依頼そのものは Worker と PC に残る。 */
  cancel: () => void;
};

type Failed = Extract<RunState, { kind: 'failed' }>;

function answerFailure(pc: string, a: MobileLaunchAnswer | undefined): Failed {
  const pcFail = (message: string, more: Partial<Failed> = {}): Failed => ({ kind: 'failed', at: 'pc', message, ...more });
  if (!a || a.ok) return pcFail(`${pc} で会話を開始できませんでした。`);
  switch (a.reason) {
    case 'project-missing':
      return pcFail('その PC にプロジェクトのディレクトリがありません。別の PC を選ぶか、PC の hangar でディレクトリを追加してください。');
    case 'account-missing':
      return pcFail('その PC に選んだアカウントがありません。アカウントを選び直してください。');
    case 'images-missing':
      return pcFail(`画像を ${pc} に渡せませんでした。もう一度送信してください。`);
    case 'bad-payload':
      return pcFail(`${pc} で依頼を開けませんでした。キーが合っていません。PC の設定 › クラウド で新しい QR を表示し、このスマホを接続し直してください。`, { reconnect: true });
    case 'expired':
      return pcFail(`${pc} の受信が遅れ、時間切れになりました。もう一度送信してください。`);
    default:
      return pcFail(`${pc} で会話を開始できませんでした。`, { detail: typeof a.detail === 'string' && a.detail.trim() ? a.detail : undefined });
  }
}

/** 画像を置けなかった。 */
function imageFailure(e: unknown): Failed {
  return { kind: 'failed', at: 'send', message: imageFailureText(e, '画像を送信できませんでした', 'もう一度送信してください。') };
}

function requestFailure(pc: string, e: unknown): Failed {
  const reason = e instanceof LaunchError ? e.reason : 'server';
  const status = e instanceof LaunchError ? e.status : null;
  const sendFail = (message: string): Failed => ({ kind: 'failed', at: 'send', message });
  switch (reason) {
    case 'rate-limited':
      return sendFail('送信の上限です。新しい会話は 10 分に 10 件までです。しばらく待ってから送信してください。');
    case 'not-found':
      return sendFail(`${pc} はクラウドに参加していません。別の PC を選んでください。`);
    case 'conflict':
      return sendFail('依頼の番号が重なりました。もう一度送信してください。');
    case 'too-large':
      return sendFail('初期プロンプトが長すぎます。短くしてから送信してください。');
    case 'network':
      return sendFail('送信できませんでした。通信を確認して、もう一度送信してください。');
    default:
      return sendFail(status ? `送信できませんでした（${status}）。しばらくしてからもう一度送信してください。` : '送信できませんでした。しばらくしてからもう一度送信してください。');
  }
}

/**
 * 依頼を送り、答えが決まるまで読む。画面を閉じても続く（呼び手が cancel するまで）。
 * 届いたか分からないまま失敗したときの retry は、同じ id で送る（Worker と PC に二度起こさせない）。
 * id が重なった（409）ときと、Worker が受けた後の失敗は、次を新しい id にする。
 * 画像は、送る id の下に置けていなければ、依頼の前に全部置く。
 * PC が答えると Worker はその依頼の画像を消すので、新しい id での送り直しでは置き直しになる。
 */
export function startLaunch(
  pairing: Pairing,
  key: PhoneKey,
  spec: LaunchSpec,
  o: { onState: (s: RunState) => void; everyMs?: number; giveUpMs?: number; putImage?: PutImage },
): LaunchRun {
  let cancelled = false;
  let stopWait: (() => void) | null = null;
  let current: RunState = { kind: 'sending' };
  let unsentId: string | null = spec.id ?? null;
  /** 画像を置き終えた依頼の id。 */
  let placed: string | null = spec.id ?? null;
  const images = spec.images ?? [];
  const put = o.putImage ?? defaultPutImage;
  const emit = (s: RunState): void => {
    if (cancelled) return;
    current = s;
    o.onState(s);
  };

  const attempt = async (): Promise<void> => {
    const fresh = unsentId ?? globalThis.crypto.randomUUID();
    unsentId = fresh;
    emit({ kind: 'sending' });
    if (images.length > 0 && placed !== fresh) {
      try {
        for (const im of images) await put(pairing, key, fresh, im.n, im.data);
      } catch (e) {
        if (cancelled) return;
        if (e instanceof ImageError && e.reason === 'unpaired') {
          emit({ kind: 'unpaired' });
          return;
        }
        emit(imageFailure(e));
        return;
      }
      placed = fresh;
      if (cancelled) return;
    }
    let id: string;
    try {
      id = await requestLaunch(pairing, key, { id: fresh, targetDevice: spec.targetDevice, skewMs: spec.skewMs, payload: spec.payload });
    } catch (e) {
      if (e instanceof LaunchError && e.reason === 'conflict') unsentId = null;
      if (cancelled) return;
      if (e instanceof LaunchError && e.reason === 'unpaired') {
        emit({ kind: 'unpaired' });
        return;
      }
      emit(requestFailure(spec.pcName, e));
      return;
    }
    unsentId = null;
    if (cancelled) return;
    stopWait = waitLaunch(pairing, key, id, {
      everyMs: o.everyMs,
      giveUpMs: o.giveUpMs,
      onClaimed: () => emit({ kind: 'waiting', claimed: true }),
      onStage: (s: LaunchStage, a?: MobileLaunchAnswer) => {
        if (s === 'waiting') emit({ kind: 'waiting', claimed: false });
        else if (s === 'started') emit(a && a.ok ? { kind: 'started', sessionId: a.sessionId, title: a.title } : { kind: 'unreadable' });
        else if (s === 'unreadable') emit({ kind: 'unreadable' });
        else if (s === 'unanswered') emit({ kind: 'unanswered' });
        else if (s === 'unpaired') emit({ kind: 'unpaired' });
        else if (s === 'expired') emit({ kind: 'failed', at: 'pc', message: `${spec.pcName} から応答がありません。${spec.pcName} で hangar が実行中か確認して、もう一度送信してください。` });
        else emit(answerFailure(spec.pcName, a));
      },
    });
  };

  void attempt();
  return {
    retry: () => {
      if (cancelled || current.kind !== 'failed') return;
      stopWait?.();
      stopWait = null;
      void attempt();
    },
    cancel: () => {
      cancelled = true;
      stopWait?.();
      stopWait = null;
    },
  };
}
