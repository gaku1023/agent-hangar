import type { CodexEffortOption, CodexModelOption, CodexOptionsDto, CodexStatusDto } from '@agent-hangar/shared';
import { captureOutput } from '../../platform/capture.ts';
import { needsShell } from '../../platform/exec.ts';
import { codexBaseEnv } from './env.ts';

/**
 * 新しいセッションで Codex を選んだときの選択肢（docs/design.md「Codex の起動の画面」）。
 * モデルの一覧と、モデルごとに選べる推論の段階は `codex debug models` から読む。app-server を起こさずに済み、ログインの有無にも左右されない。
 * 出力は 500KB ほどあるので、読むのはモデルの名前と推論の段階だけにして、取った一覧を手元に持つ。
 */

/** 一覧を取り直さずに返す間。 */
const FRESH_MS = 60_000;
/** `codex debug models` の出力の上限。モデルごとの長い指示を含むので大きい。 */
const MAX_BYTES = 8 * 1024 * 1024;

type RawModel = { slug?: unknown; display_name?: unknown; description?: unknown; default_reasoning_level?: unknown; visibility?: unknown; priority?: unknown; supported_reasoning_levels?: unknown };

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** `codex debug models` の出力から、選べるモデルを priority の小さい順に取り出す。形が違えば投げる。 */
export function parseCodexModels(out: string): CodexModelOption[] {
  const raw = JSON.parse(out) as { models?: unknown };
  if (!raw || !Array.isArray(raw.models)) throw new Error('codex debug models: unexpected output');
  const rows = (raw.models as RawModel[])
    .filter((m) => m && typeof m.slug === 'string' && m.slug !== '' && m.visibility === 'list')
    .map((m) => ({ m, priority: typeof m.priority === 'number' ? m.priority : Number.MAX_SAFE_INTEGER }))
    .sort((a, b) => a.priority - b.priority);
  return rows.map(({ m }) => {
    const efforts: CodexEffortOption[] = (Array.isArray(m.supported_reasoning_levels) ? m.supported_reasoning_levels : [])
      .filter((e): e is { effort: string; description?: unknown } => !!e && typeof (e as { effort?: unknown }).effort === 'string')
      .map((e) => ({ id: e.effort, description: str(e.description) }));
    const def = str(m.default_reasoning_level);
    return { id: m.slug as string, label: str(m.display_name) || (m.slug as string), description: str(m.description), efforts, defaultEffort: def || null };
  });
}

export type CodexOptionsDeps = {
  /** いまの codex の場所。見つからなければ null。呼ばれた時点の値を読む。 */
  bin: () => string | null;
  /** 手元の codex の版と確かめの結果（設定の検出と同じ口）。 */
  status: () => Promise<CodexStatusDto>;
  /** `codex debug models` を打って出力を返す口。試験が差し替える。 */
  run?: (bin: string) => Promise<string>;
  now?: () => number;
  freshMs?: number;
  timeoutMs?: number;
};

export class CodexOptionsService {
  private cached: CodexOptionsDto | null = null;
  private inflight: Promise<CodexOptionsDto> | null = null;

  constructor(private readonly deps: CodexOptionsDeps) {}

  /** 選択肢。間もなければ手元の一覧を返す。取り直しに失敗しても、手元に前の一覧があればそれを返す。 */
  async get(o: { refresh?: boolean } = {}): Promise<CodexOptionsDto> {
    const now = (this.deps.now ?? Date.now)();
    if (!o.refresh && this.cached && now - this.cached.fetchedAt < (this.deps.freshMs ?? FRESH_MS)) return this.cached;
    if (this.inflight) return this.inflight;
    const p = this.fetch(now).finally(() => { this.inflight = null; });
    this.inflight = p;
    return p;
  }

  /**
   * 手元の一覧を待たずに返す。無ければ null で、裏で取り始める。間が空いていれば、手元の一覧を返したあとで裏で取り直す。
   * スマホの問い合わせ（呼び鈴は 5 秒しか待てない）が使う。取り直しの失敗は捨てる（手元の一覧が残る）。
   */
  last(): CodexOptionsDto | null {
    const now = (this.deps.now ?? Date.now)();
    if (!this.cached || now - this.cached.fetchedAt >= (this.deps.freshMs ?? FRESH_MS)) void this.get().catch(() => undefined);
    return this.cached;
  }

  private async fetch(now: number): Promise<CodexOptionsDto> {
    try {
      const bin = this.deps.bin();
      if (!bin) throw new Error('codex not found');
      const [status, out] = await Promise.all([this.deps.status(), (this.deps.run ?? this.defaultRun)(bin)]);
      const dto: CodexOptionsDto = { version: status.version, verified: status.verified, models: parseCodexModels(out), fetchedAt: now };
      this.cached = dto;
      return dto;
    } catch (e) {
      if (this.cached) return this.cached;
      throw e;
    }
  }

  private defaultRun = async (bin: string): Promise<string> => {
    const r = await captureOutput(bin, ['debug', 'models'], { timeoutMs: this.deps.timeoutMs ?? 20_000, env: codexBaseEnv(bin), maxBytes: MAX_BYTES, shell: needsShell(bin) });
    if (r.code !== 0) throw new Error(`codex debug models exited with ${r.code}`);
    return r.stdout;
  };
}
