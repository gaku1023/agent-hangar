// 作者への問い合わせの 2 段（下書きと送信）。MCP の draft_issue_report と submit_issue_report の中身である。

import { randomUUID } from 'node:crypto';
import type { GetLanguage } from '../i18n/language.ts';
import { MessageError, msg, render } from '../i18n/message.ts';
import { composeReport, parseReportInput, type ReportEnv } from './compose.ts';
import { newIssueUrl, searchSimilar, type FetchFn, type SimilarIssue } from './github.ts';
import { makeRedactor, type RedactContext } from './redact.ts';

/** 下書きを置いておく長さ。利用者が読んで承諾するのに足り、古い下書きを送らない長さにする。 */
export const DRAFT_TTL_MS = 30 * 60_000;

export type ReportServiceDeps = {
  repo: string;
  env: () => Promise<ReportEnv>;
  redactContext: () => RedactContext;
  fetch: FetchFn;
  gh: {
    /** gh が見つかり、ログイン済みか。 */
    available(): Promise<boolean>;
    /** issue を作り、その URL を返す。作れなければ投げる。 */
    create(repo: string, title: string, body: string): Promise<string>;
  };
  openUrl: (url: string) => Promise<void>;
  language: GetLanguage;
  now: () => number;
  newId?: () => string;
};

type Draft = { title: string; body: string; expiresAt: number };

export type DraftResult = {
  draft_id: string;
  title: string;
  body: string;
  redactions: number;
  similar: SimilarIssue[] | null;
  will_send_via: 'gh' | 'browser';
  expires_at: number;
  instructions: string;
};

export type SubmitResult =
  | { sent_via: 'gh'; url: string }
  | { sent_via: 'browser'; url: string; truncated: boolean; full_body?: string; gh_error?: string; notice: string };

/**
 * 下書きはメモリにだけ置く。サーバが落ちれば消える。
 * submit は本文を受け取らず ID だけを受け取る。利用者に見せた後で Claude が中身を書き換えて送れないようにするためである。
 */
export class ReportService {
  private readonly drafts = new Map<string, Draft>();

  constructor(private readonly deps: ReportServiceDeps) {}

  async draft(args: Record<string, unknown>): Promise<DraftResult> {
    const input = parseReportInput(args);
    const language = this.deps.language();
    const composed = composeReport(input, await this.deps.env(), language);
    const redact = makeRedactor(this.deps.redactContext());
    const title = redact(composed.title);
    const body = redact(composed.body);
    const [similar, viaGh] = await Promise.all([searchSimilar(this.deps.fetch, this.deps.repo, title.text), this.deps.gh.available()]);
    const now = this.deps.now();
    this.sweep(now);
    const id = (this.deps.newId ?? randomUUID)();
    const expiresAt = now + DRAFT_TTL_MS;
    this.drafts.set(id, { title: title.text, body: body.text, expiresAt });
    return {
      draft_id: id, title: title.text, body: body.text, redactions: title.count + body.count, similar,
      will_send_via: viaGh ? 'gh' : 'browser', expires_at: expiresAt,
      instructions: render(language, msg(viaGh ? 'report.draft.instructionsGh' : 'report.draft.instructionsBrowser')),
    };
  }

  /**
   * 承諾の検査を下書きの検索より先に行う。承諾が無ければ下書きは残し、承諾を得た後にそのまま送れるようにする。
   * gh で作るのに失敗したらブラウザへ回す。送り先へ届いたかは分からないので、下書きは送る操作を始めた時点で消す。
   */
  async submit(args: Record<string, unknown>): Promise<SubmitResult> {
    if (args.confirmed !== true) throw new MessageError(msg('report.submit.notConfirmed'));
    const id = typeof args.draft_id === 'string' ? args.draft_id : '';
    this.sweep(this.deps.now());
    const d = this.drafts.get(id);
    if (!d) throw new MessageError(msg('report.submit.draftNotFound', { id }));
    this.drafts.delete(id);
    let ghError: string | undefined;
    if (await this.deps.gh.available()) {
      try {
        return { sent_via: 'gh', url: await this.deps.gh.create(this.deps.repo, d.title, d.body) };
      } catch (e) {
        ghError = e instanceof Error ? e.message : String(e);
      }
    }
    const language = this.deps.language();
    const { url, truncated } = newIssueUrl(this.deps.repo, d.title, d.body, render(language, msg('report.submit.truncatedNote')));
    await this.deps.openUrl(url);
    return {
      sent_via: 'browser', url, truncated,
      ...(truncated ? { full_body: d.body } : {}),
      ...(ghError !== undefined ? { gh_error: ghError } : {}),
      notice: render(language, msg('report.submit.browserNotice')),
    };
  }

  private sweep(now: number): void {
    for (const [id, d] of this.drafts) if (d.expiresAt < now) this.drafts.delete(id);
  }
}
