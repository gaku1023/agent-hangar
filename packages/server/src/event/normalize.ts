import { createHmac, timingSafeEqual } from 'node:crypto';
import type { EventFacts } from '@agent-hangar/shared';

/**
 * GitHub の webhook の荷物を、結び付けに当てる事実（EventFacts）に直す（#563）。
 * 署名の確かめもここに置く。荷物を開くのは puller.ts で、ここは文字列と JSON だけを見る。
 */

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Obj) : null);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined);
const int = (v: unknown): number | undefined => (typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? v : undefined);

/** `sha256=<hex 64 字>` の形。 */
const SIGNATURE = /^sha256=([0-9a-f]{64})$/i;

/**
 * x-hub-signature-256 を確かめる。本文（届いたままの文字列）の HMAC-SHA256 を、定数時間で比べる。
 * 見出しが無い、形が違う、秘密の値が空のときは偽。
 */
export function verifyGithubSignature(secret: string, body: string, header: string | undefined): boolean {
  if (!secret || !header) return false;
  const m = SIGNATURE.exec(header);
  if (!m) return false;
  const want = createHmac('sha256', secret).update(body, 'utf8').digest();
  const got = Buffer.from(m[1]!, 'hex');
  return got.length === want.length && timingSafeEqual(got, want);
}

type Outcome = NonNullable<EventFacts['outcome']>;
const WORST: Record<Outcome, number> = { success: 0, cancelled: 1, failure: 2 };

/** スイートの結論を、成否の 3 通りに寄せる。知らない結論は失敗として数える。 */
function outcomeOf(conclusion: unknown): Outcome {
  switch (conclusion) {
    case 'success': case 'neutral': case 'skipped': return 'success';
    case 'cancelled': return 'cancelled';
    default: return 'failure';
  }
}

type Entry = { at: number; suites: Map<number, Outcome | null> };

/**
 * 同じ head の SHA にあるチェックスイートが全部終わったかを数える。
 * requested と rerequested で終わっていない印を付け、completed で結論を入れる。
 * 全部の結論が入ったところで 1 つの成否にまとめて返し、その head の覚えは捨てる。
 * 終わらないスイートが残っても溜まり続けないよう、ttlMs を過ぎた覚えと、max 件を超えた古い覚えは落とす。
 * 覚えはメモリだけで、再起動で消える。消えたあとの completed は、そのスイートだけで数える。
 */
export class CheckSuiteTracker {
  private readonly entries = new Map<string, Entry>();
  private readonly ttlMs: number;
  private readonly max: number;

  constructor(o: { ttlMs?: number; max?: number } = {}) {
    this.ttlMs = o.ttlMs ?? 24 * 60 * 60_000;
    this.max = o.max ?? 200;
  }

  /** 終わっていないスイートを覚える。 */
  pending(key: string, suiteId: number, now: number): void {
    const e = this.entry(key, now);
    e.suites.set(suiteId, null);
    e.at = now;
  }

  /** スイートの結論を入れる。全部終わったら成否を返し、まだなら null。 */
  complete(key: string, suiteId: number, conclusion: unknown, now: number): Outcome | null {
    const e = this.entry(key, now);
    e.suites.set(suiteId, outcomeOf(conclusion));
    e.at = now;
    let worst: Outcome = 'success';
    for (const o of e.suites.values()) {
      if (o === null) return null;
      if (WORST[o] > WORST[worst]) worst = o;
    }
    this.entries.delete(key);
    return worst;
  }

  private entry(key: string, now: number): Entry {
    for (const [k, e] of this.entries) if (now - e.at > this.ttlMs) this.entries.delete(k);
    let e = this.entries.get(key);
    if (!e) {
      e = { at: now, suites: new Map() };
      this.entries.set(key, e);
      // Map は入れた順なので、先頭が最も古い。
      while (this.entries.size > this.max) this.entries.delete(this.entries.keys().next().value as string);
    }
    return e;
  }
}

export type NormalizeOptions = {
  /** Worker が荷物を受けた時刻。既定は今。 */
  receivedAt?: number;
  /** チェックスイートを数える入れ物。省くと、完了したスイートごとに 1 件の ci_done にする。 */
  suites?: CheckSuiteTracker;
};

/** 値のあるものだけを残す。 */
function facts(f: Omit<EventFacts, 'source'>): EventFacts {
  const out: EventFacts = { source: 'github', event: f.event, receivedAt: f.receivedAt };
  for (const k of ['repo', 'number', 'title', 'outcome', 'url', 'actor', 'body'] as const) {
    if (f[k] !== undefined) (out as Obj)[k] = f[k];
  }
  return out;
}

/**
 * GitHub の荷物（見出しの x-github-event と本文の JSON）を事実に直す。扱わない種類と動きは null。
 * 形の違う本文は投げずに null にする。
 * 本文（body）は切らずに入れる。渡すかどうかと長さは、指示を組む側（Task 5）が決める。
 * me は今の PC の gh のユーザー名。誰の書き込みかは actor に入れて、自分かどうかの判断は指示を組む側に任せる。
 */
export function normalizeGithub(eventName: string, payload: unknown, _me: string, opts: NormalizeOptions = {}): EventFacts | null {
  const p = obj(payload);
  if (!p) return null;
  const receivedAt = opts.receivedAt ?? Date.now();
  const action = str(p.action);
  const repoObj = obj(p.repository);
  const repo = str(repoObj?.full_name);
  const repoUrl = str(repoObj?.html_url);
  const sender = str(obj(p.sender)?.login);

  switch (eventName) {
    case 'check_suite': {
      const s = obj(p.check_suite);
      const id = int(s?.id);
      const sha = str(s?.head_sha);
      if (!s || id === undefined || !sha || !repo) return null;
      const key = `${repo}@${sha}`;
      if (action === 'requested' || action === 'rerequested') {
        opts.suites?.pending(key, id, receivedAt);
        return null;
      }
      if (action !== 'completed') return null;
      const outcome = opts.suites ? opts.suites.complete(key, id, s.conclusion, receivedAt) : outcomeOf(s.conclusion);
      if (outcome === null) return null;
      const prs = Array.isArray(s.pull_requests) ? s.pull_requests : [];
      const number = prs.map((x) => int(obj(x)?.number)).find((n) => n !== undefined);
      const url = repoUrl ? (number !== undefined ? `${repoUrl}/pull/${number}` : `${repoUrl}/commit/${sha}`) : undefined;
      return facts({ event: 'ci_done', repo, number, outcome, url, actor: sender, receivedAt });
    }
    case 'pull_request': {
      const pr = obj(p.pull_request);
      if (action !== 'closed' || !pr) return null;
      return facts({ event: pr.merged === true ? 'merged' : 'closed', repo, number: int(pr.number), title: str(pr.title), url: str(pr.html_url), actor: sender, receivedAt });
    }
    case 'pull_request_review': {
      const review = obj(p.review);
      const pr = obj(p.pull_request);
      if (action !== 'submitted' || !review || !pr) return null;
      return facts({ event: 'review', repo, number: int(pr.number), title: str(pr.title), url: str(review.html_url) ?? str(pr.html_url), actor: str(obj(review.user)?.login) ?? sender, body: str(review.body), receivedAt });
    }
    case 'issue_comment': {
      const issue = obj(p.issue);
      const comment = obj(p.comment);
      if (action !== 'created' || !issue || !comment) return null;
      return facts({ event: 'comment', repo, number: int(issue.number), title: str(issue.title), url: str(comment.html_url) ?? str(issue.html_url), actor: str(obj(comment.user)?.login) ?? sender, body: str(comment.body), receivedAt });
    }
    case 'pull_request_review_comment': {
      const pr = obj(p.pull_request);
      const comment = obj(p.comment);
      if (action !== 'created' || !pr || !comment) return null;
      return facts({ event: 'comment', repo, number: int(pr.number), title: str(pr.title), url: str(comment.html_url) ?? str(pr.html_url), actor: str(obj(comment.user)?.login) ?? sender, body: str(comment.body), receivedAt });
    }
    case 'issues': {
      const issue = obj(p.issue);
      if (action !== 'opened' || !issue) return null;
      return facts({ event: 'issue_opened', repo, number: int(issue.number), title: str(issue.title), url: str(issue.html_url), actor: str(obj(issue.user)?.login) ?? sender, body: str(issue.body), receivedAt });
    }
    default:
      return null;
  }
}
