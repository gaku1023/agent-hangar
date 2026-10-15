import { describe, expect, it, vi } from 'vitest';
import { MessageError } from '../i18n/message.ts';
import { DRAFT_TTL_MS, ReportService, type ReportServiceDeps } from './service.ts';

const bugArgs = { kind: 'bug', title: 'alice の一覧が出ない', symptom: '/Users/alice/work/app で空になる', steps: '1. 開く' };

function setup(over: Partial<ReportServiceDeps> = {}) {
  let now = 1_000;
  const opened: string[] = [];
  const created: { repo: string; title: string; body: string }[] = [];
  const deps: ReportServiceDeps = {
    repo: 'o/r',
    env: async () => ({ hangarVersion: '0.6.1', claudeVersion: '2.1.300', os: 'darwin 27.0.0 (alice-mbp)', arch: 'arm64' }),
    redactContext: () => ({ home: '/Users/alice', user: 'alice', host: 'alice-mbp', projects: [{ name: 'app', path: '/Users/alice/work/app' }] }),
    fetch: async () => new Response(JSON.stringify({ items: [{ number: 3, title: 'similar', html_url: 'https://x/3', state: 'open' }] })),
    gh: {
      available: async () => true,
      create: async (repo, title, body) => { created.push({ repo, title, body }); return 'https://github.com/o/r/issues/9'; },
    },
    openUrl: async (u) => { opened.push(u); },
    language: () => 'ja',
    now: () => now,
    newId: () => 'd1',
    ...over,
  };
  return { svc: new ReportService(deps), opened, created, advance: (ms: number) => { now += ms; } };
}

describe('ReportService.draft', () => {
  it('伏せた下書きと似た issue と送り方を返し、外へは送らない', async () => {
    const { svc, opened, created } = setup();
    const d = await svc.draft(bugArgs);
    expect(d.draft_id).toBe('d1');
    expect(d.title).toBe('[bug] <user> の一覧が出ない');
    expect(d.body).toContain('<project-1> で空になる');
    expect(d.body).toContain('- OS: darwin 27.0.0 (<host>)');
    expect(d.body).not.toMatch(/alice/);
    expect(d.redactions).toBe(3);
    expect(d.similar).toEqual([{ number: 3, title: 'similar', url: 'https://x/3' }]);
    expect(d.will_send_via).toBe('gh');
    expect(d.instructions).toMatch(/submit_issue_report/);
    expect(opened).toEqual([]);
    expect(created).toEqual([]);
  });

  it('gh が使えなければ送り方はブラウザ、検索に失敗すれば similar は null', async () => {
    const { svc } = setup({ gh: { available: async () => false, create: vi.fn() }, fetch: async () => { throw new Error('x'); } });
    const d = await svc.draft(bugArgs);
    expect(d.will_send_via).toBe('browser');
    expect(d.similar).toBeNull();
  });

  it('引数が崩れていれば断る', async () => {
    const { svc } = setup();
    await expect(svc.draft({ kind: 'bug', title: 't' })).rejects.toThrow(MessageError);
  });
});

describe('ReportService.submit', () => {
  it('confirmed が true でなければ断り、下書きは残す', async () => {
    const { svc, created } = setup();
    await svc.draft(bugArgs);
    await expect(svc.submit({ draft_id: 'd1' })).rejects.toThrow(MessageError);
    await expect(svc.submit({ draft_id: 'd1', confirmed: 'yes' })).rejects.toThrow(MessageError);
    expect(created).toEqual([]);
    await expect(svc.submit({ draft_id: 'd1', confirmed: true })).resolves.toMatchObject({ sent_via: 'gh' });
  });

  it('gh で下書きをそのまま作り、下書きを消す', async () => {
    const { svc, created } = setup();
    const d = await svc.draft(bugArgs);
    const r = await svc.submit({ draft_id: 'd1', confirmed: true });
    expect(r).toEqual({ sent_via: 'gh', url: 'https://github.com/o/r/issues/9' });
    expect(created).toEqual([{ repo: 'o/r', title: d.title, body: d.body }]);
    await expect(svc.submit({ draft_id: 'd1', confirmed: true })).rejects.toThrow(MessageError);
  });

  it('gh が使えなければブラウザで下書きの URL を開く', async () => {
    const { svc, opened } = setup({ gh: { available: async () => false, create: vi.fn() } });
    await svc.draft(bugArgs);
    const r = await svc.submit({ draft_id: 'd1', confirmed: true });
    expect(r.sent_via).toBe('browser');
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatch(/^https:\/\/github\.com\/o\/r\/issues\/new\?/);
    expect(r).toMatchObject({ url: opened[0], truncated: false });
  });

  it('gh で作るのに失敗したらブラウザへ回し、その理由を添える', async () => {
    const { svc, opened } = setup({ gh: { available: async () => true, create: async () => { throw new Error('HTTP 410'); } } });
    await svc.draft(bugArgs);
    const r = await svc.submit({ draft_id: 'd1', confirmed: true });
    expect(r.sent_via).toBe('browser');
    expect(r).toMatchObject({ gh_error: 'HTTP 410' });
    expect(opened).toHaveLength(1);
  });

  it('長い本文は切り詰めた URL を開き、全文を返す', async () => {
    const { svc } = setup({ gh: { available: async () => false, create: vi.fn() } });
    const d = await svc.draft({ ...bugArgs, notes: 'x'.repeat(9000) });
    const r = await svc.submit({ draft_id: 'd1', confirmed: true });
    expect(r).toMatchObject({ truncated: true, full_body: d.body });
  });

  it('30 分を過ぎた下書きは送らない', async () => {
    const { svc, advance, created } = setup();
    await svc.draft(bugArgs);
    advance(DRAFT_TTL_MS + 1);
    await expect(svc.submit({ draft_id: 'd1', confirmed: true })).rejects.toThrow(MessageError);
    expect(created).toEqual([]);
  });
});
