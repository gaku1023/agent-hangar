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
 *
 * auth は `claude auth status --json` の読み取り（accountAuth.ts の parseAuthStatus）で、方式の欄は取らずに email と plan だけを持つ。
 * claude.ai のログインには email があり、API キーや外部のプロバイダには無いので、email が無ければ claude.ai のログインとは見なさない。
 * env は、アカウントの CLAUDE_CONFIG_DIR を足した後の、claude を起こす環境である。
 */
export function remoteControlAllowed(o: { enabled: boolean; auth: AccountAuthDto | null; env: Record<string, string | undefined> }): boolean {
  if (!o.enabled) return false;
  if (!o.auth || !o.auth.loggedIn || !o.auth.email) return false;
  return !o.env.ANTHROPIC_BASE_URL && !o.env.ANTHROPIC_API_KEY;
}
