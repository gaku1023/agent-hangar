import fs from 'node:fs';
import path from 'node:path';
import type { LaunchResultDto } from '@agent-hangar/shared';
import type { Db } from '../db/open.ts';
import { msg } from '../i18n/message.ts';
import { resolvePhysical } from '../provider/codex/transcript/logical.ts';
import { listRolloutFiles, parseRolloutName } from '../provider/codex/transcript/discover.ts';
import { decompressZstd } from '../provider/codex/transcript/zstd.ts';
import { RunError } from '../runs/errors.ts';
import { AGENT_SYNC, codexSessionOfPath, codexSyncPath, codexSyncPathOfFile } from './agentSync.ts';
import { copyOverAtomically, isPrefixOf, pickVerifiedRemote, resolveUnder, type RemotePick } from './copy.ts';

/**
 * Codex の会話の「この PC で再開」（docs/design.md「Codex の本文」の「この PC で再開」、計画の E2）。
 *
 * 降ろした写し（remote/<元の PC>/codex/sessions/... か .../archived_sessions/...）を `$CODEX_HOME` の置き場（codexHomePath の形）に写してから、
 * ふだんの再開（RunManager.resumeWith）で app-server を起こし、`thread/resume` で開く。
 * Codex の DB（state_5.sqlite など）と索引には触らない。codex が起動のときに置かれた rollout を拾い直す（probe-codex-e0）。
 *
 * 写す前に、その thread の書き手の座（writer lock）を握る、この PC の hangar が起こした app-server を止める（stopWriters）。
 * 握られたままだと、resume が `already has an active writer` で断られる。
 *
 * rollout は追記だけで伸びるので、手元と写しはバイトの先頭部分で比べる。
 * - 同じか、写しが手元の先頭部分（手元の方が進んでいる）なら、書かずに開く。
 * - 手元が写しの先頭部分（ほかの PC が続きを進めた）なら、写しで置き換える。何も失わないので承諾は求めない。
 * - どちらでもない（両方で別の続きを書いた）なら、競合として上書きせずに 409 で断る。resume しただけで 1 行足されるので、2 台で開くとここに来る。
 *   承諾があっても置き換えない。片方の続きが黙って消えるからである。
 *
 * 置き場は、手元に rollout があればその場所（sessions/ か archived_sessions/）のまま、無ければ sessions/YYYY/MM/DD/ である（アーカイブ済みの写しも sessions/ に置く）。
 * この PC でアーカイブ済みの会話は、codex の DB がアーカイブ済みと覚えているので、ファイルを sessions/ へ動かしても resume は断られる（0.164.0 で確かめた）。
 * そこで置き場は動かさず、再開の `thread/unarchive`（provider/codex/driver.ts）に戻させる。
 * 作業の場所（cwd）は、再開（RunManager.cwdFor）がプロジェクトの対応づけで決め、最初の `thread/resume` に渡す。
 */

export type CodexResumeDeps = {
  db: Db;
  /** hangar の home（~/.agent-hangar）。降ろした写しは remote/ の下にある。 */
  home: string;
  deviceId: string;
  /** `$CODEX_HOME`。呼ばれた時点の値を読む。 */
  codexHome: () => string;
  /**
   * 写す前の確かめと用意。RunManager.prepareResumeDir を渡す。
   * 設定が切、この PC で動いている run、実行ファイルが無い、場所が無いときに断り、ほかの PC のクイックセッションのフォルダを作る。
   */
  prepare: (sessionId: string) => string;
  /** その thread の書き手の座を握る、この PC の hangar が起こした app-server を止める（driver の release）。 */
  stopWriters: (sessionId: string, threadId: string) => Promise<void>;
  /** 写したあとの再開。RunManager.resumeWith を渡す。 */
  resume: (sessionId: string) => Promise<LaunchResultDto>;
};

/** 手元の rollout。logical は .jsonl の名前、physical は実体（.jsonl.zst のこともある）。 */
type LocalRollout = { logical: string; physical: string; compressed: boolean };

function codexRow(db: Db, sessionId: string): { provider_session_id: string } | null {
  const s = db.prepare("select provider_session_id from sessions where id = ? and provider = 'codex' and deleted_at is null").get(sessionId) as { provider_session_id: string } | undefined;
  return s && AGENT_SYNC.codex.isSessionId(s.provider_session_id) ? s : null;
}

/** 台帳の指紋と合う、ほかの PC の最も新しい写し。 */
export function pickRemoteCodex(db: Db, home: string, self: string, threadId: string): (RemotePick & { rel: string }) | null {
  if (!AGENT_SYNC.codex.isSessionId(threadId)) return null;
  const pick = pickVerifiedRemote({ db, home, keyLike: `codex/%/${threadId}.jsonl.gz`, ledgerKeyOf: (d) => AGENT_SYNC.codex.ledgerKey(d, threadId, null), exclude: self });
  if (!pick) return null;
  const row = db.prepare('select path from file_sync where key = ?').get(AGENT_SYNC.codex.ledgerKey(pick.deviceId, threadId, null)) as { path: string } | undefined;
  return row && codexSessionOfPath(row.path) === threadId ? { ...pick, rel: row.path } : null;
}

/**
 * 手元の rollout を探す。索引の行（論理パス）と、写しの名前から求めた置き場（sessions/ と archived_sessions/）を見る。
 * sessions/ の側を先に採る（Codex の索引と同じ）。$CODEX_HOME の外のものは採らない。
 * どれにも無ければ、$CODEX_HOME を走査して thread の UUID で探す（索引がまだ見ていない、日付のフォルダが違う）。
 */
function findLocal(db: Db, codexHome: string, sessionId: string, threadId: string, name: string | null): LocalRollout | null {
  const candidates: string[] = [];
  if (name) {
    candidates.push(path.join(codexHome, ...codexSyncPath(name, false).split('/').slice(1)), path.join(codexHome, ...codexSyncPath(name, true).split('/').slice(1)));
  }
  for (const r of db.prepare('select path from transcript_files where session_id = ? and agent_id is null and device_id is null').all(sessionId) as { path: string }[]) {
    const rel = codexSyncPathOfFile(codexHome, r.path);
    if (rel !== null && codexSessionOfPath(rel) === threadId) candidates.push(r.path);
  }
  const ordered = [...new Set(candidates)].sort((a, b) => Number(a.includes(`${path.sep}archived_sessions${path.sep}`)) - Number(b.includes(`${path.sep}archived_sessions${path.sep}`)));
  for (const logical of ordered) {
    const p = resolvePhysical(logical);
    if (p) return { logical, physical: p.path, compressed: p.compressed };
  }
  const found = listRolloutFiles(codexHome).files.find((f) => f.sessionId === threadId);
  const p = found ? resolvePhysical(found.path) : null;
  return found && p ? { logical: found.path, physical: p.path, compressed: p.compressed } : null;
}

/** 手元と写しの比べ。same は同じか手元が進んでいる、ahead は手元が写しの先頭部分、diverged は食い違い。 */
function compare(localFile: LocalRollout, remote: string): 'same' | 'ahead' | 'diverged' {
  if (localFile.compressed) {
    const a = decompressZstd(fs.readFileSync(localFile.physical));
    const b = fs.readFileSync(remote);
    if (a.length >= b.length) return a.subarray(0, b.length).equals(b) ? 'same' : 'diverged';
    return b.subarray(0, a.length).equals(a) ? 'ahead' : 'diverged';
  }
  if (isPrefixOf(remote, localFile.physical)) return 'same';
  return isPrefixOf(localFile.physical, remote) ? 'ahead' : 'diverged';
}

/** $CODEX_HOME の下の相対パス（sessions/... か archived_sessions/...）へ、写しを原子的に置く。途中の段がリンクなら断る。 */
function place(codexHome: string, rel: string, from: string): string {
  fs.mkdirSync(codexHome, { recursive: true, mode: 0o700 });
  const target = resolveUnder(codexHome, rel, '$CODEX_HOME', { create: true });
  copyOverAtomically(from, target);
  return target;
}

/** Codex の会話を、ほかの PC の写しで手元の rollout を伸ばしてから再開する。$CODEX_HOME へ本文を置くのは、ここだけである（削除はゴミ箱へ移すだけ）。 */
export async function resumeCodexHere(deps: CodexResumeDeps, sessionId: string, _overwrite = false): Promise<LaunchResultDto> {
  const s = codexRow(deps.db, sessionId);
  if (!s) throw new RunError(400, msg('sync.resume.noTranscript'));
  const threadId = s.provider_session_id;
  deps.prepare(sessionId);
  // 書き手の座を握る app-server を、比べる前に止める。止める途中の interrupt が rollout に行を足すからである。
  await deps.stopWriters(sessionId, threadId);
  const codexHome = deps.codexHome();
  const pick = pickRemoteCodex(deps.db, deps.home, deps.deviceId, threadId);
  const name = pick ? path.posix.basename(pick.rel) : null;
  const localFile = findLocal(deps.db, codexHome, sessionId, threadId, name);
  if (!pick) {
    if (!localFile) throw new RunError(400, msg('sync.resume.noTranscript'));
    return deps.resume(sessionId);
  }
  let verdict: 'same' | 'ahead' | 'diverged' = 'ahead';
  // 読めない手元（壊れた .jsonl.zst、展開の上限を超えるもの）は、何を消すか分からないので食い違いとして扱い、書かない。
  if (localFile) { try { verdict = compare(localFile, pick.path); } catch { verdict = 'diverged'; } }
  if (verdict === 'diverged') throw new RunError(409, msg('sync.resume.codexDiverged'));
  if (verdict === 'ahead') {
    // 置き場は手元の rollout の場所のまま（アーカイブ済みなら archived_sessions/）。無ければ sessions/YYYY/MM/DD/ に置く。
    const rel = localFile
      ? path.relative(codexHome, localFile.logical).split(path.sep).join('/')
      : codexSyncPath(name!, false).split('/').slice(1).join('/');
    if (!parseRolloutName(path.posix.basename(rel))) throw new RunError(409, msg('sync.copy.badRelPath'));
    place(codexHome, rel, pick.path);
    // 圧縮された実体は、置いた .jsonl と並べない（同じ会話が 2 つにならない）。codex も resume で展開するときに消す。
    if (localFile?.compressed) fs.rmSync(localFile.physical, { force: true });
  }
  return deps.resume(sessionId);
}

/** 止める口（driver の release）。会話の ID で 1 度、続けて thread の ID で（ほかの hangar の会話が同じ thread を握っていれば）止める。 */
type Releaser = { launch: { release(target: { sessionId?: string; providerSessionId: string; cwd: string }, why: 'killed'): unknown } };

/**
 * その thread の書き手の座を握る、この PC の hangar が起こした app-server を止める。
 * hangar の外の codex（利用者が素のターミナルで起こしたもの）は止めない。それが握っていれば、再開の thread/resume が断り、理由を返す。
 * 同じ thread を握る app-server は、ふつう 1 本だが、止まらない限り（上限 4 本まで）thread の ID で探し直す。
 */
export async function stopCodexWriters(driver: Releaser, sessionId: string, threadId: string): Promise<void> {
  await Promise.resolve(driver.launch.release({ sessionId, providerSessionId: threadId, cwd: '' }, 'killed')).catch(() => false);
  for (let i = 0; i < 4; i++) {
    const stopped = await Promise.resolve(driver.launch.release({ providerSessionId: threadId, cwd: '' }, 'killed')).catch(() => false);
    if (stopped !== true) return;
  }
}
