import { execFile } from 'node:child_process';
import { KOKORO_VOICES, type VoiceCatalog, type VoiceSourceId } from '@agent-hangar/shared';

/**
 * 声の一覧（docs/design.md「机の音声」の声の出どころ）。
 * VOICEVOX と AivisSpeech はエンジンの HTTP の /speakers、この Mac の声は補助の voices 命令、Kokoro は固定の一覧。
 * エンジンは同梱しない。応えなければその出どころは running:false で、画面が「開く」を出す。
 */

export type EngineId = 'voicevox' | 'aivis';
type Source = VoiceCatalog['sources'][number];

/** エンジンの待ちの上限。遅いエンジンのために一覧の全体を待たせない。 */
export const ENGINE_WAIT_MS = 1000;

const ENGINES: Record<EngineId, { defaultUrl: string; envKey: string; app: string }> = {
  voicevox: { defaultUrl: 'http://127.0.0.1:50021', envKey: 'HANGAR_VOICEVOX_URL', app: 'VOICEVOX' },
  aivis: { defaultUrl: 'http://127.0.0.1:10101', envKey: 'HANGAR_AIVIS_URL', app: 'AivisSpeech' },
};

/** エンジンの口。環境変数で替えられるが、127.0.0.1 の http 以外（外の機械、認証情報つき）は使わず既定へ戻す。 */
export function engineUrl(id: EngineId, env: NodeJS.ProcessEnv): string {
  const e = ENGINES[id];
  const raw = env[e.envKey];
  if (raw) {
    try {
      const u = new URL(raw);
      if (u.protocol === 'http:' && u.hostname === '127.0.0.1' && u.username === '' && u.password === '') return `http://127.0.0.1${u.port ? `:${u.port}` : ''}`;
    } catch { /* 壊れた URL は既定へ */ }
  }
  return e.defaultUrl;
}

export type CatalogDeps = { env: NodeJS.ProcessEnv; fetch?: typeof fetch; timeoutMs?: number };

const isStyleId = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;
const isRec = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** エンジンの /speakers を読む。応えない、遅い、壊れた応答は running:false で speakers は空。 */
export async function fetchEngineSource(id: EngineId, deps: CatalogDeps): Promise<Source> {
  const down: Source = { id, running: false, speakers: [] };
  const ms = deps.timeoutMs ?? ENGINE_WAIT_MS;
  const ac = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  try {
    const f = deps.fetch ?? fetch;
    const work = (async () => {
      const r = await f(`${engineUrl(id, deps.env)}/speakers`, { signal: ac.signal });
      if (!r.ok) return null;
      return (await r.json()) as unknown;
    })();
    const limit = new Promise<null>((resolve) => { timer = setTimeout(() => { ac.abort(); resolve(null); }, ms); });
    const body = await Promise.race([work, limit]);
    if (!Array.isArray(body)) return down;
    const speakers: Source['speakers'] = [];
    for (const sp of body) {
      if (!isRec(sp) || typeof sp.name !== 'string' || !Array.isArray(sp.styles)) continue;
      const styles: Source['speakers'][number]['styles'] = [];
      for (const st of sp.styles) {
        if (!isRec(st) || typeof st.name !== 'string' || !isStyleId(st.id)) continue;
        if (st.type !== undefined && st.type !== 'talk') continue;
        styles.push({ name: st.name, voice: `${id}:${st.id}` });
      }
      if (styles.length > 0) speakers.push({ name: sp.name, styles });
    }
    return { id, running: true, speakers };
  } catch {
    return down;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** この Mac の声（補助が返した値）。補助が答えなかったときは、呼ぶ側が最後に受けた値（無ければ空）を渡す。 */
export type OsVoices = { running: boolean; voices: Array<{ id: string; name: string }> };

/** 声の一覧。2 つのエンジンは並行に待つ。並びは kokoro・voicevox・aivis・os。 */
export async function buildCatalog(deps: CatalogDeps & { os: OsVoices }): Promise<VoiceCatalog> {
  const [voicevox, aivis] = await Promise.all([fetchEngineSource('voicevox', deps), fetchEngineSource('aivis', deps)]);
  const kokoro: Source = { id: 'kokoro', running: true, speakers: KOKORO_VOICES.map((v) => ({ name: v, styles: [{ name: '', voice: `kokoro:${v}` }] })) };
  const os: Source = { id: 'os', running: deps.os.running, speakers: deps.os.voices.map((v) => ({ name: v.name, styles: [{ name: '', voice: `os:${v.id}` }] })) };
  return { sources: [kokoro, voicevox, aivis, os] };
}

export type OpenEngineDeps = { platform: NodeJS.Platform; exec?: (file: string, args: string[]) => Promise<unknown> };

const execFileP = (file: string, args: string[]): Promise<unknown> => new Promise((resolve, reject) => {
  execFile(file, args, { timeout: 10_000 }, (err) => { if (err) reject(err); else resolve(undefined); });
});

/** エンジンのアプリを `open -a` で起こす（シェルを通さない）。macOS 以外は何もせず unsupported。 */
export async function openEngine(source: EngineId, deps: OpenEngineDeps): Promise<'ok' | 'unsupported' | { failed: string }> {
  if (deps.platform !== 'darwin') return 'unsupported';
  try {
    await (deps.exec ?? execFileP)('open', ['-a', ENGINES[source].app]);
    return 'ok';
  } catch (e) {
    return { failed: e instanceof Error ? e.message : String(e) };
  }
}

export const isEngineId = (v: unknown): v is EngineId => v === 'voicevox' || v === 'aivis';
export type { VoiceSourceId };
