import { createHmac, timingSafeEqual } from 'node:crypto';
import type { EventFacts } from '@agent-hangar/shared';

/**
 * GitHub の webhook の荷物を、結び付けに当てる事実（EventFacts）に直す（#563）。
 * 署名の確かめもここに置く。
 * 荷物を開くのは puller.ts で、ここは文字列と JSON だけを見る。
 */

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Obj) : null);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined);
const int = (v: unknown): number | undefined => (typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? v : undefined);

/**
 * `sha256=<hex 64 字>` の形。
 * 接頭辞は小文字の sha256= だけを受け、16 進の部分は大小どちらでもよい。
 */
const SIGNATURE = /^sha256=([0-9a-fA-F]{64})$/;

/**
 * x-hub-signature-256 を確かめる。
 * 本文（届いたままの文字列）の HMAC-SHA256 を、定数時間で比べる。
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

/**
 * スイートの結論を、成否の 3 通りに寄せる。
 * 知らない結論（action_required、startup_failure など）は失敗として数える。
 */
export function outcomeOf(conclusion: unknown): Outcome {
  switch (conclusion) {
    case 'success': case 'neutral': case 'skipped': return 'success';
    case 'cancelled': return 'cancelled';
    default: return 'failure';
  }
}

/**
 * check_suite の completed が指す repo、head の SHA、スイートの ID。
 * 形が違えば null。
 */
export function checkSuiteRef(payload: unknown): { repo: string; sha: string; suiteId: number } | null {
  const p = obj(payload);
  const repo = str(obj(p?.repository)?.full_name);
  const suite = obj(p?.check_suite);
  const sha = str(suite?.head_sha);
  const suiteId = int(suite?.id);
  return repo && sha && suiteId !== undefined ? { repo, sha, suiteId } : null;
}

export type NormalizeOptions = {
  /**
   * Worker が荷物を受けた時刻。
   * 既定は今。
   */
  receivedAt?: number;
};

/**
 * payload の labels（{ name } の並び）から名前を取る。
 * 無い、空のときは undefined。
 */
function labelsOf(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const names = v.map((l) => str(obj(l)?.name)).filter((n): n is string => n !== undefined);
  return names.length > 0 ? names : undefined;
}

/** 値のあるものだけを残す。 */
function facts(f: Omit<EventFacts, 'source'>): EventFacts {
  const out: EventFacts = { source: 'github', event: f.event, receivedAt: f.receivedAt };
  for (const k of ['repo', 'number', 'title', 'authorLogin', 'outcome', 'url', 'actor', 'body', 'labels'] as const) {
    if (f[k] !== undefined) (out as Obj)[k] = f[k];
  }
  return out;
}

/**
 * GitHub の荷物（見出しの x-github-event と本文の JSON）を事実に直す。
 * 扱わない種類と動きは null。
 * 形の違う本文は投げずに null にする。
 * check_suite の completed は、そのスイート 1 つの成否の ci_done にする。
 * 同じ head の残りのスイートを見て 1 件にまとめるのは puller の仕事で、GitHub への問い合わせが要るのでここでは行わない。
 * labels は issue か PR の札の名前で、結び付けの札の絞り込みに使う。
 * 本文（body）は切らずに入れる。
 * 渡すかどうかと長さは、指示を組む側（Task 5）が決める。
 * me は今の PC の gh のユーザー名。
 * 誰の書き込みかは actor に入れて、自分かどうかの判断は指示を組む側に任せる。
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
      const sha = str(s?.head_sha);
      if (!s || !sha || !repo) return null;
      // リポジトリの webhook に届く check_suite は completed だけである（requested と rerequested は持ち主の App にだけ届く）。
      if (action !== 'completed') return null;
      const outcome = outcomeOf(s.conclusion);
      const prs = Array.isArray(s.pull_requests) ? s.pull_requests : [];
      const number = prs.map((x) => int(obj(x)?.number)).find((n) => n !== undefined);
      const url = repoUrl ? (number !== undefined ? `${repoUrl}/pull/${number}` : `${repoUrl}/commit/${sha}`) : undefined;
      return facts({ event: 'ci_done', repo, number, outcome, url, actor: sender, receivedAt });
    }
    case 'pull_request': {
      const pr = obj(p.pull_request);
      if (action !== 'closed' || !pr) return null;
      return facts({ event: pr.merged === true ? 'merged' : 'closed', repo, number: int(pr.number), title: str(pr.title), authorLogin: str(obj(pr.user)?.login), url: str(pr.html_url), actor: sender, labels: labelsOf(pr.labels), receivedAt });
    }
    case 'pull_request_review': {
      const review = obj(p.review);
      const pr = obj(p.pull_request);
      if (action !== 'submitted' || !review || !pr) return null;
      return facts({ event: 'review', repo, number: int(pr.number), title: str(pr.title), authorLogin: str(obj(pr.user)?.login), url: str(review.html_url) ?? str(pr.html_url), actor: str(obj(review.user)?.login) ?? sender, body: str(review.body), labels: labelsOf(pr.labels), receivedAt });
    }
    case 'issue_comment': {
      const issue = obj(p.issue);
      const comment = obj(p.comment);
      if (action !== 'created' || !issue || !comment) return null;
      return facts({ event: 'comment', repo, number: int(issue.number), title: str(issue.title), authorLogin: str(obj(issue.user)?.login), url: str(comment.html_url) ?? str(issue.html_url), actor: str(obj(comment.user)?.login) ?? sender, body: str(comment.body), labels: labelsOf(issue.labels), receivedAt });
    }
    case 'pull_request_review_comment': {
      const pr = obj(p.pull_request);
      const comment = obj(p.comment);
      if (action !== 'created' || !pr || !comment) return null;
      return facts({ event: 'comment', repo, number: int(pr.number), title: str(pr.title), authorLogin: str(obj(pr.user)?.login), url: str(comment.html_url) ?? str(pr.html_url), actor: str(obj(comment.user)?.login) ?? sender, body: str(comment.body), labels: labelsOf(pr.labels), receivedAt });
    }
    case 'issues': {
      const issue = obj(p.issue);
      if (action !== 'opened' || !issue) return null;
      return facts({ event: 'issue_opened', repo, number: int(issue.number), title: str(issue.title), authorLogin: str(obj(issue.user)?.login), url: str(issue.html_url), actor: str(obj(issue.user)?.login) ?? sender, body: str(issue.body), labels: labelsOf(issue.labels), receivedAt });
    }
    default:
      return null;
  }
}
