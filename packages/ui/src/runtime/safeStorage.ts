/**
 * localStorage を JSON で読み書きする入れ物。Runtime の `storage` にそのまま渡す。
 * localStorage は、プライベートウィンドウ、サイトデータを塞いだ設定、容量の超過、ストレージの無い環境で、
 * 取得（`window.localStorage` を読むだけ）も、読み書きも、鍵の一覧も投げることがある。
 * どれが投げても投げ返さない。読めなければ undefined、書けなければ黙って捨て、鍵の一覧は空にする。
 * 呼ぶたびに取得し直すのは、取得そのものが投げる環境でも、ほかの呼びを巻き込まないためである。
 */
export type SafeStorage = { get(key: string): unknown; set(key: string, value: unknown): void; keys(): string[] };

export function createSafeStorage(local: () => Storage): SafeStorage {
  return {
    get: (key) => { try { const v = local().getItem(key); return v ? JSON.parse(v) : undefined; } catch { return undefined; } },
    set: (key, value) => { try { local().setItem(key, JSON.stringify(value)); } catch { /* 容量超過などは無視 */ } },
    keys: () => { try { return Object.keys(local()); } catch { return []; } },
  };
}
