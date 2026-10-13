import type { LiveSessionDto, PermissionAskDto } from '@agent-hangar/shared';
import type { Db } from '../db/open.ts';
import type { PermissionHook } from '../provider/claude-code/hooks/permission.ts';

/**
 * 待ちに入らないまま残った中身を捨てるまでの長さ。
 * hook と登録の waiting のどちらが先に届くかは決まらない。hook が先なら、登録が追いつくまで残す。
 * 自動で許された（許可の規則に当たった）確認でも hook は走るので、待ちに入らなかった中身はこの長さで捨てる。
 */
export const PERMISSION_ASK_TTL_MS = 30_000;

/**
 * Claude が求めている許可の中身を、会話（Claude のセッションの id）ごとに預かる。
 * 手元だけの一時の事実なので、DB にも同期にも載せない。サーバを起こし直したら忘れる（札は「内容はターミナルに出ています」に戻る）。
 * 登録の読み直し（RegistryWatcher の enrich）のたびに apply を通し、入力待ちの登録に permission を足す。
 * 待ちに入ったのを見た後、待ちを抜けたら忘れる（許可した、断った）。
 * 許可でない待ち（waitingFor が other、たとえば許可した直後に Claude Code が出すダイアログ）には足さず、
 * 許可の待ちを見た後にそこへ移ったら忘れる。status は waiting のまま続くので、待ちを抜けるのを待つと前の命令が残る。
 * 問いの待ち（question）は AskUserQuestion の確認だけを足す（Claude Code が問いにどの waitingFor を書くかは版で変わる）。
 */
export class PermissionAsks {
  private asks = new Map<string, { ask: PermissionAskDto; at: number; seen: boolean }>();

  /**
   * onPut は預けたときに呼ぶ。登録の見張り（RegistryWatcher.kick）に、次の読み直しを繰り上げさせる。
   * 待機中の読み直しは間が空くので、hook が登録の後に届いたとき、許可の中身を札と通知に載せるのが遅れないようにする。
   */
  constructor(private readonly onPut: () => void = () => {}) {}

  put(providerSessionId: string, ask: PermissionAskDto, now: number): void {
    this.asks.set(providerSessionId, { ask, at: now, seen: false });
    this.onPut();
  }

  apply(live: LiveSessionDto[], now: number): LiveSessionDto[] {
    if (this.asks.size === 0) return live;
    const present = new Set(live.map((l) => l.sessionId));
    for (const [id, a] of this.asks) if (!present.has(id) && now - a.at > PERMISSION_ASK_TTL_MS) this.asks.delete(id);
    return live.map((l) => {
      const a = this.asks.get(l.sessionId);
      if (!a) return l;
      if (l.status === 'waiting') {
        if (!forThisWait(a.ask, l)) {
          if (a.seen) this.asks.delete(l.sessionId);
          return l;
        }
        a.seen = true;
        return { ...l, permission: a.ask };
      }
      if (a.seen || now - a.at > PERMISSION_ASK_TTL_MS) this.asks.delete(l.sessionId);
      return l;
    });
  }
}

/** 預かった確認が、その入力待ちの中身か。waitingFor の無い登録（古い Claude Code）は今までどおり足す。 */
function forThisWait(ask: PermissionAskDto, l: LiveSessionDto): boolean {
  if (l.waitingFor === undefined || l.waitingFor === 'permission') return true;
  return l.waitingFor === 'question' && ask.tool === 'AskUserQuestion';
}

/**
 * hook から届いた許可の確認を預ける。
 * sessionId は受け口の URL のセッション（hangar の id）で、run の秘密はそのセッションの入口だけを開ける。
 * hook の会話がそのセッションのものでなければ預けない（/clear で会話が替わった後など）。預けたら true。
 */
export function applyPermissionHook(db: Db, sessionId: string, hook: PermissionHook, asks: Pick<PermissionAsks, 'put'>, now: number): boolean {
  const s = db.prepare('select provider_session_id from sessions where id = ? and deleted_at is null').get(sessionId) as { provider_session_id: string } | undefined;
  if (!s || s.provider_session_id !== hook.providerSessionId) return false;
  asks.put(hook.providerSessionId, hook.ask, now);
  return true;
}
