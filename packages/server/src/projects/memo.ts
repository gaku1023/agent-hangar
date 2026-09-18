import fs from 'node:fs';
import path from 'node:path';
import type { MemoDto } from '@agent-hangar/shared';
import type { Db } from '../db/open.ts';
import { upsertShared } from '../db/shared.ts';

export { memoHead } from '../db/queries.ts';

type Row = { project_id: string; markdown: string; updated_at: number };

/**
 * プロジェクトのメモ。
 * SQLite の project_memos を同期の正とし、~/.agent-hangar/projects/<projectId>/memo.md にも同じ内容を置く。
 * ファイルは他のエディタや Claude 自身が直接書けるので、ファイルの方が新しければファイルを正として DB を直す。
 */
export class MemoStore {
  private readonly db: Db;
  private readonly deviceId: string;
  private readonly home: string;
  private readonly debounceMs: number;

  constructor(o: { db: Db; deviceId: string; home: string; debounceMs?: number }) {
    this.db = o.db;
    this.deviceId = o.deviceId;
    this.home = o.home;
    this.debounceMs = o.debounceMs ?? 300;
  }

  memoPath(projectId: string): string {
    return path.join(this.home, 'projects', projectId, 'memo.md');
  }

  private row(projectId: string): Row | null {
    return (this.db.prepare('select project_id, markdown, updated_at from project_memos where project_id = ? and deleted_at is null').get(projectId) as Row | undefined) ?? null;
  }

  private toDto(r: Row): MemoDto {
    return { projectId: r.project_id, markdown: r.markdown, updatedAt: r.updated_at };
  }

  /** ファイルを書き、mtime を DB の updated_at に合わせる（次の reconcile が「同じ」と判定できるように）。 */
  private writeFile(projectId: string, markdown: string, updatedAt: number): void {
    const file = this.memoPath(projectId);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, markdown);
    const t = new Date(updatedAt);
    fs.utimesSync(file, t, t);
  }

  /**
   * DB の行をファイルの内容と時刻に合わせる。
   * upsertShared は updated_at を今にするので、changes に積んだ差分ごとファイルの mtime で揃える。
   * 同期の競合解決は updated_at の新しい方を採るので、ここがずれると外部編集の時刻が失われる。
   */
  private adoptFile(projectId: string, markdown: string, mtime: number): Row {
    const write = this.db.transaction(() => {
      upsertShared(this.db, 'project_memos', { project_id: projectId, markdown, deleted_at: null }, this.deviceId, 'project_id');
      this.db.prepare('update project_memos set updated_at = ? where project_id = ?').run(mtime, projectId);
      this.db.prepare(`update changes set updated_at = ?, payload = json_set(payload, '$.updated_at', ?)
        where table_name = 'project_memos' and row_id = ?
          and seq = (select max(seq) from changes where table_name = 'project_memos' and row_id = ?)`)
        .run(mtime, mtime, projectId, projectId);
    });
    write();
    return this.row(projectId)!;
  }

  /** そのプロジェクトが DB にあるか。無い id のメモを書くと外部キー違反になる。 */
  private projectExists(projectId: string): boolean {
    return this.db.prepare('select 1 from projects where id = ?').get(projectId) !== undefined;
  }

  read(projectId: string): MemoDto | null {
    this.reconcile(projectId);
    const r = this.row(projectId);
    return r ? this.toDto(r) : null;
  }

  write(projectId: string, markdown: string): MemoDto {
    upsertShared(this.db, 'project_memos', { project_id: projectId, markdown, deleted_at: null }, this.deviceId, 'project_id');
    const r = this.row(projectId)!;
    this.writeFile(projectId, r.markdown, r.updated_at);
    return this.toDto(r);
  }

  /**
   * ファイルと DB を突き合わせる。
   * ファイルが新しく中身が違えばファイルを正として DB を直す。
   * ファイルが無いか古いときは DB を正として写しを書き戻す（利用者のファイルは消さない）。
   */
  reconcile(projectId: string): { changed: boolean; memo: MemoDto | null } {
    const file = this.memoPath(projectId);
    const r = this.row(projectId);
    // 知らないプロジェクトのディレクトリは放っておく。
    // 消さないし、取り込んで外部キー違反で落ちることもしない。
    if (!r && !this.projectExists(projectId)) return { changed: false, memo: null };
    if (!fs.existsSync(file)) {
      if (r) this.writeFile(projectId, r.markdown, r.updated_at);
      return { changed: false, memo: r ? this.toDto(r) : null };
    }
    // utimesSync は秒の浮動小数で渡るので、書いた時刻がナノ秒で 1 ミリ秒弱ずれて戻ることがある。
    // 四捨五入して元のミリ秒に戻す。
    const mtime = Math.round(fs.statSync(file).mtimeMs);
    const markdown = fs.readFileSync(file, 'utf8');
    if (r) {
      if (markdown === r.markdown) return { changed: false, memo: this.toDto(r) };
      if (mtime <= r.updated_at) {
        // ファイルの方が古い。DB が正なので、写しを直しておく。
        this.writeFile(projectId, r.markdown, r.updated_at);
        return { changed: false, memo: this.toDto(r) };
      }
    }
    return { changed: true, memo: this.toDto(this.adoptFile(projectId, markdown, mtime)) };
  }

  /** ディレクトリにあるメモをすべて照合し、変わったものを返す。起動時に呼ぶ。 */
  reconcileAll(): MemoDto[] {
    const root = path.join(this.home, 'projects');
    if (!fs.existsSync(root)) return [];
    const out: MemoDto[] = [];
    for (const d of fs.readdirSync(root, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      // 1 つのディレクトリの失敗で起動時の照合を止めない。
      try {
        const r = this.reconcile(d.name);
        if (r.changed && r.memo) out.push(r.memo);
      } catch {
        // 読めないディレクトリは次の変化で拾う。
      }
    }
    return out;
  }

  /** <home>/projects を監視し、変化した memo.md を debounce 後に取り込む。 */
  watch(onChange: (memo: MemoDto) => void): () => void {
    const root = path.join(this.home, 'projects');
    fs.mkdirSync(root, { recursive: true });
    const timers = new Map<string, NodeJS.Timeout>();
    const watcher = fs.watch(root, { recursive: true }, (_event, name) => {
      if (!name) return;
      const parts = String(name).split(path.sep);
      const projectId = parts[0];
      if (!projectId || parts[parts.length - 1] !== 'memo.md') return;
      const prev = timers.get(projectId);
      if (prev) clearTimeout(prev);
      timers.set(projectId, setTimeout(() => {
        timers.delete(projectId);
        try {
          const r = this.reconcile(projectId);
          if (r.changed && r.memo) onChange(r.memo);
        } catch {
          // 読めない瞬間は次の変化で拾う。
        }
      }, this.debounceMs));
    });
    watcher.on('error', () => {
      // 監視が壊れても読み書きは動く。
    });
    return () => {
      watcher.close();
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
    };
  }
}
