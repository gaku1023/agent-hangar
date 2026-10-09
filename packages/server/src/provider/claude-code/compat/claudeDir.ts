import fs from 'node:fs';
import { LINKED_ENTRIES } from '../../../config/accountLinks.ts';
import { splitDriftValue, type CompatSink, type Drift } from './types.ts';

/**
 * アカウントごとに持つと決めた直下の項目。
 * 認証、組織から配られる設定、キャッシュ、常駐のサービスの状態と、古い版が作った置き場である
 * （docs/superpowers/specs/2026-10-06-account-switch-design.md と、その後に実物の置き場で見たもの）。
 */
export const KNOWN_PER_ACCOUNT_ENTRIES: ReadonlySet<string> = new Set([
  '.claude.json', '.credentials.json', '.last-cleanup', '.last-update-result.json', 'backups', 'cache', 'daemon', 'daemon.log',
  'downloads', 'ide', 'policy-limits.json', 'policy-limits.json.stamp.json', 'remote-settings.json', 'statsig', 'telemetry', 'todos',
]);
/** Claude Code が作るものではないので見ない名前。 */
const IGNORED: ReadonlySet<string> = new Set(['.DS_Store']);

/** 共有のリンクでも、アカウントごとに持つと知っている項目でも、見ない名前でもない名前か。 */
const isUnknownEntry = (name: string): boolean => !LINKED_ENTRIES.includes(name) && !KNOWN_PER_ACCOUNT_ENTRIES.has(name) && !IGNORED.has(name);

/**
 * 記録に残った置き場の項目の値が、今の一覧でもずれかを返す。
 * 共有のリンクの一覧か、アカウントごとに持つ項目の一覧に入った名前はずれでない。知らない形の値はずれのままにする。
 * 項目がまだ置き場にあるかは、値だけでは分からないので見ない（記録は手元の claude の版が変わるまで残る）。
 */
export function isClaudeDirDrift(value: string): boolean {
  const kv = splitDriftValue(value);
  return kv === null || kv[0] !== 'entry' || isUnknownEntry(kv[1]);
}

/**
 * 2 つ目以降のアカウントの置き場の直下に、共有のリンクでも、アカウントごとに持つと知っている項目でもないものがあれば、ずれとして返す。
 * Claude Code が新しい項目を足すと、リンクの一覧（LINKED_ENTRIES）に無いので、アカウントごとの実体になる。これがアカウントを切り替えると共有されない項目である。
 * 振る舞いは変えない（アカウントごとのままにする）。
 * 最初の置き場（~/.claude）は見ない。利用者が自分で置いたファイル（dotfiles の git など）と見分けられないためである。
 */
export function claudeDirDrifts(dir: string): Drift[] {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  return entries
    .filter((e) => !e.isSymbolicLink() && isUnknownEntry(e.name))
    .map((e) => e.name)
    .sort()
    .map((name) => ({ contract: 'claude-dir' as const, value: `entry=${name}`, version: null }));
}

/**
 * 置き場の見張り。起動のときと、準備の確かめ（GET /api/readiness）か GET /api/compat を読むたびに check() を呼ぶ。
 * 同じ名前はサーバの寿命で 1 度だけ数える。画面を開くたびに読み直すので、回数は意味を持たない。
 */
export class ClaudeDirWatch {
  private readonly seen = new Set<string>();
  constructor(private readonly o: { dirs: () => string[]; sink: CompatSink }) {}

  check(): void {
    for (const dir of this.o.dirs()) {
      for (const d of claudeDirDrifts(dir)) {
        if (this.seen.has(d.value)) continue;
        this.seen.add(d.value);
        this.o.sink.note(d);
      }
    }
  }

  /** 見た名前を忘れる。ずれの記録が空になったとき、次の check() でまだある項目を数え直す。 */
  reset(): void {
    this.seen.clear();
  }
}
