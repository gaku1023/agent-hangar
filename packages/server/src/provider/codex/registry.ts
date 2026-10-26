import fs from 'node:fs';
import path from 'node:path';

/**
 * hangar が起こした codex app-server の記録（docs/design.md「Codex の起動（ベータ）」）。
 * hangar を閉じても app-server は残る（tmux の中の TUI がつないだままだからである）。次に hangar が起きたら、この記録から引き継ぐ（driver.ts の reattach）。
 * 書くのは接続に要るものだけで、capability token そのものは書かない（0600 のファイルのパスだけを書く）。
 */
export type CodexServeRecord = {
  sessionId: string;
  pid: number;
  port: number;
  tokenFile: string;
  startedAt: number;
  cwd: string;
  /** スレッドの ID。初期プロンプトが無い会話は、TUI がつないで拾えるまで無い。 */
  threadId?: string;
};

export const codexRegistryPath = (home: string): string => path.join(home, 'codex', 'app-servers.json');

const isRecord = (v: unknown): v is CodexServeRecord => {
  const r = v as Partial<CodexServeRecord> | null;
  return typeof r === 'object' && r !== null && typeof r.sessionId === 'string' && Number.isInteger(r.pid) && Number.isInteger(r.port)
    && typeof r.tokenFile === 'string' && typeof r.startedAt === 'number' && typeof r.cwd === 'string' && (r.threadId === undefined || typeof r.threadId === 'string');
};

export class CodexRegistry {
  constructor(readonly file: string) {}

  /** 記録を読む。無い、壊れている、形の違う行は、無いものとして読む。 */
  list(): CodexServeRecord[] {
    try {
      const v: unknown = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return Array.isArray(v) ? v.filter(isRecord) : [];
    } catch {
      return [];
    }
  }

  get(sessionId: string): CodexServeRecord | null {
    return this.list().find((r) => r.sessionId === sessionId) ?? null;
  }

  set(r: CodexServeRecord): void {
    this.write([...this.list().filter((x) => x.sessionId !== r.sessionId), r]);
  }

  remove(sessionId: string): void {
    const now = this.list();
    const next = now.filter((x) => x.sessionId !== sessionId);
    if (next.length !== now.length) this.write(next);
  }

  private write(list: CodexServeRecord[]): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      const tmp = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(list), { mode: 0o600 });
      fs.renameSync(tmp, this.file);
    } catch {
      // 記録が書けなくても会話は動く。引き継げなくなるだけである。
    }
  }
}
