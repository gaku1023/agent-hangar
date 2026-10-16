import type { AccountAuthDto } from '@agent-hangar/shared';

/** 名前も指示もプロジェクト名も無いときの名前。空のままだと、続く引数（初期プロンプト）を名前として飲む。 */
const FALLBACK_NAME = 'Hangar';
const NAME_MAX = 40;

/** 改行と連なる空白をひとつの空白にして、先頭の `-` を外す。名前は argv の別の要素で渡すが、`-` で始まるとフラグに読まれうる。 */
function tidy(v: string | undefined | null): string {
  return (v ?? '').replace(/\s+/g, ' ').trim().replace(/^-+/, '').trim();
}

/**
 * `--remote-control` に渡す名前。名前があればそれ、無ければ指示の先頭 40 字、それも無ければプロジェクト名。
 * 一覧の題の決め方（db/queries.ts の displayName）と同じ順である。
 */
export function remoteControlName(o: { name?: string; prompt?: string; projectName?: string | null }): string {
  return tidy(o.name) || Array.from(tidy(o.prompt)).slice(0, NAME_MAX).join('').trim() || tidy(o.projectName) || FALLBACK_NAME;
}

/**
 * `--remote-control` を付けてよいか。
 * Remote Control は claude.ai のログインでしか使えないので、設定が入で、認証が claude.ai のログインで、
 * `ANTHROPIC_BASE_URL` と `ANTHROPIC_API_KEY` が空のときだけ true にする。
 * 実物では API キーのとき黙って無視されて起動は通ったが、保守的に付けない。
 * supported は、手元の claude の `--help` の Options に `--remote-control` があるか（compat/localClaude.ts）。
 * 古い claude は知らない引数で起動に失敗しうるので、読めていない（分からない）ときも付けない。
 *
 * auth は `claude auth status --json` の読み取り（accountAuth.ts の parseAuthStatus）で、方式の欄は取らずに email と plan だけを持つ。
 * claude.ai のログインには email があり、API キーや外部のプロバイダには無いので、email が無ければ claude.ai のログインとは見なさない。
 * env は、アカウントの CLAUDE_CONFIG_DIR を足した後の、claude を起こす環境である。
 */
export function remoteControlAllowed(o: RemoteControlGateInput): boolean {
  return remoteControlRefusal(o) === null;
}

/** `--remote-control` を付けない理由。どの条件で落ちたかを、秘密を含まない名前で表す。 */
export type RemoteControlRefusal = 'disabled' | 'unsupported' | 'auth-unknown' | 'logged-out' | 'no-email' | 'base-url' | 'api-key';

type RemoteControlGateInput = { enabled: boolean; supported: boolean; auth: AccountAuthDto | null; env: Record<string, string | undefined> };

/**
 * remoteControlAllowed と同じ判定で、付けないときはその理由を返す。付けてよければ null。
 * auth-unknown は、そのアカウントの認証をまだ読んでいない（または読めなかった）ことを表す。
 */
export function remoteControlRefusal(o: RemoteControlGateInput): RemoteControlRefusal | null {
  if (!o.enabled) return 'disabled';
  if (!o.supported) return 'unsupported';
  if (!o.auth) return 'auth-unknown';
  if (!o.auth.loggedIn) return 'logged-out';
  if (!o.auth.email) return 'no-email';
  if (o.env.ANTHROPIC_BASE_URL) return 'base-url';
  if (o.env.ANTHROPIC_API_KEY) return 'api-key';
  return null;
}
