/**
 * app-server の JSON Schema（`codex app-server generate-json-schema` の出力）のうち、hangar が使う分だけの控えを作り、比べる道具。
 * 見張りの仕組みは docs/design.md「Codex の互換の見張り」にある。
 * 控えは、使う要求と通知の包み（method と params の参照）と、そこから参照をたどった定義だけで、説明文（description）は入れない。
 * 説明文は版ごとに書き換わるが、hangar の読み方は変わらないので、落とす理由にならない。
 */

export type SchemaMethod = {
  /** request は ClientRequest、notification は ServerNotification、serverRequest は ServerRequest の中の包み。 */
  kind: 'request' | 'notification' | 'serverRequest';
  method: string;
  /** 答えの定義の名前（`v2/ThreadStartResponse` のように、定義の置き場の道）。要求の答えを読むものだけ。 */
  response?: string;
};

/** hangar（provider/codex）が送る要求、読む通知、受ける承認の要求。使うものを足したら、ここへ足して見本を採り直す。 */
export const HANGAR_CODEX_METHODS: readonly SchemaMethod[] = [
  { kind: 'request', method: 'initialize', response: 'InitializeResponse' },
  { kind: 'request', method: 'thread/start', response: 'v2/ThreadStartResponse' },
  { kind: 'request', method: 'thread/resume', response: 'v2/ThreadResumeResponse' },
  { kind: 'request', method: 'thread/fork', response: 'v2/ThreadForkResponse' },
  { kind: 'request', method: 'thread/read', response: 'v2/ThreadReadResponse' },
  { kind: 'request', method: 'thread/loaded/list', response: 'v2/ThreadLoadedListResponse' },
  { kind: 'request', method: 'turn/start', response: 'v2/TurnStartResponse' },
  { kind: 'request', method: 'turn/interrupt', response: 'v2/TurnInterruptResponse' },
  { kind: 'request', method: 'mcpServerStatus/list', response: 'v2/ListMcpServerStatusResponse' },
  { kind: 'request', method: 'account/rateLimits/read', response: 'v2/GetAccountRateLimitsResponse' },
  { kind: 'notification', method: 'thread/started' },
  { kind: 'notification', method: 'thread/status/changed' },
  { kind: 'notification', method: 'thread/name/updated' },
  { kind: 'notification', method: 'thread/tokenUsage/updated' },
  { kind: 'notification', method: 'turn/started' },
  { kind: 'notification', method: 'turn/completed' },
  { kind: 'notification', method: 'account/rateLimits/updated' },
  { kind: 'notification', method: 'serverRequest/resolved' },
  { kind: 'serverRequest', method: 'item/commandExecution/requestApproval' },
  { kind: 'serverRequest', method: 'item/fileChange/requestApproval' },
  { kind: 'serverRequest', method: 'item/permissions/requestApproval' },
  { kind: 'serverRequest', method: 'item/tool/requestUserInput' },
  { kind: 'serverRequest', method: 'mcpServer/elicitation/request' },
];

export type SchemaSubset = {
  /** `<kind> <method>` から、包み（union の 1 つの枝）と、答えの定義の名前。 */
  methods: Record<string, { variant: unknown; response?: string }>;
  /** 定義の置き場の道（`v2/Turn`、`InitializeParams`）から定義。 */
  definitions: Record<string, unknown>;
};

const UNION_OF: Record<SchemaMethod['kind'], string> = { request: 'ClientRequest', notification: 'ServerNotification', serverRequest: 'ServerRequest' };
const REF_PREFIX = '#/definitions/';

type Json = unknown;
type Rec = Record<string, Json>;
const isRec = (v: Json): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);

/** description を落とし、キーを並べ替える（控えの差分が行ごとに読めるように）。 */
function canon(v: Json): Json {
  if (Array.isArray(v)) return v.map(canon);
  if (!isRec(v)) return v;
  const out: Rec = {};
  for (const k of Object.keys(v).sort()) if (k !== 'description') out[k] = canon(v[k]);
  return out;
}

function refsOf(v: Json, into: Set<string>): void {
  if (Array.isArray(v)) { for (const x of v) refsOf(x, into); return; }
  if (!isRec(v)) return;
  for (const [k, x] of Object.entries(v)) {
    if (k === '$ref' && typeof x === 'string') {
      if (!x.startsWith(REF_PREFIX)) throw new Error(`unsupported $ref: ${x}`);
      into.add(x.slice(REF_PREFIX.length));
    } else refsOf(x, into);
  }
}

/** 定義の置き場の道（`v2/Turn`）から定義を引く。 */
function definitionAt(bundle: Rec, key: string): Json {
  let cur: Json = bundle.definitions;
  for (const part of key.split('/')) {
    if (!isRec(cur) || !(part in cur)) throw new Error(`definition not found: ${key}`);
    cur = cur[part];
  }
  return cur;
}

/** 束（codex_app_server_protocol.schemas.json）から、使う分の控えを取り出す。見つからないものは、黙らず投げる。 */
export function extractSchemaSubset(bundle: Json, methods: readonly SchemaMethod[] = HANGAR_CODEX_METHODS): SchemaSubset {
  if (!isRec(bundle) || !isRec(bundle.definitions)) throw new Error('not a JSON Schema bundle (no definitions)');
  const subset: SchemaSubset = { methods: {}, definitions: {} };
  const todo = new Set<string>();
  for (const m of methods) {
    const union = (bundle.definitions as Rec)[UNION_OF[m.kind]];
    const variants = isRec(union) && Array.isArray(union.oneOf) ? union.oneOf : [];
    const variant = variants.find((v) => isRec(v) && isRec(v.properties) && isRec(v.properties.method) && Array.isArray(v.properties.method.enum) && v.properties.method.enum[0] === m.method);
    if (variant === undefined) throw new Error(`${m.kind} ${m.method} not found in ${UNION_OF[m.kind]}`);
    subset.methods[`${m.kind} ${m.method}`] = m.response === undefined ? { variant: canon(variant) } : { variant: canon(variant), response: m.response };
    refsOf(variant, todo);
    if (m.response !== undefined) { definitionAt(bundle, m.response); todo.add(m.response); }
  }
  const done = new Set<string>();
  while (todo.size > 0) {
    const key = todo.values().next().value as string;
    todo.delete(key);
    if (done.has(key)) continue;
    done.add(key);
    const def = definitionAt(bundle, key);
    subset.definitions[key] = canon(def);
    refsOf(def, todo);
  }
  subset.methods = Object.fromEntries(Object.entries(subset.methods).sort(([a], [b]) => (a < b ? -1 : 1)));
  subset.definitions = Object.fromEntries(Object.entries(subset.definitions).sort(([a], [b]) => (a < b ? -1 : 1)));
  return subset;
}

/** 2 つの JSON の違いを、パスつきの行にする。want が控え、got がいま。上限を越えた分は件数にまとめる。 */
export function diffJson(want: Json, got: Json, limit = 60): string[] {
  const lines: string[] = [];
  let total = 0;
  const push = (l: string) => { total++; if (lines.length < limit) lines.push(l); };
  const show = (v: Json) => { const s = JSON.stringify(v); return s.length > 120 ? `${s.slice(0, 117)}...` : s; };
  const walk = (a: Json, b: Json, path: string) => {
    if (Array.isArray(a) && Array.isArray(b)) {
      if (a.length !== b.length) push(`${path}: array length ${a.length} -> ${b.length} (fixture ${show(a)}, now ${show(b)})`);
      else a.forEach((x, i) => walk(x, b[i], `${path}[${i}]`));
    } else if (isRec(a) && isRec(b)) {
      for (const k of Object.keys(a)) {
        if (!(k in b)) push(`${path ? `${path}.` : ''}${k}: in the fixture, missing now`);
        else walk(a[k], b[k], path ? `${path}.${k}` : k);
      }
      for (const k of Object.keys(b)) if (!(k in a)) push(`${path ? `${path}.` : ''}${k}: not in the fixture, present now`);
    } else if (JSON.stringify(a) !== JSON.stringify(b)) push(`${path}: ${show(a)} -> ${show(b)}`);
  };
  walk(want, got, '');
  if (total > lines.length) lines.push(`... and ${total - lines.length} more`);
  return lines;
}
