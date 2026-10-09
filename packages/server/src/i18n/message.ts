import { DEFAULT_LANGUAGE, t, type Language, type MessageKey, type MessageParamName, type Translate } from '@agent-hangar/shared';
import { defaultLanguage, type GetLanguage } from './language.ts';

/**
 * サーバの中で持ち回る、まだ言語を決めていない文。
 * 深い層（保存、検査、起動）は言語を知らないので、鍵と引数のまま投げるか返し、
 * 利用者や Claude へ出す境目（HTTP の経路、MCP の道具）が、そのときの言語で文にする。
 * 引数には、別の文を入れられる。入れた文も、同じ言語で文になる。
 */
export type Message = { readonly key: MessageKey; readonly params?: Readonly<Record<string, MessageParam>> };
export type MessageParam = string | number | Message;
type MsgArgs<K extends MessageKey> = [MessageParamName<K>] extends [never] ? [] : [params: { [P in MessageParamName<K>]: MessageParam }];

/** 鍵と引数から文を作る。引数の数と名前は、`t()` と同じく型で決まる。 */
export function msg<K extends MessageKey>(key: K, ...args: MsgArgs<K>): Message {
  return args[0] ? { key, params: args[0] as Record<string, MessageParam> } : { key };
}

const isMessage = (v: MessageParam): v is Message => typeof v === 'object';
const loose = t as (language: Language, key: string, params?: Record<string, string | number>) => string;

/** 文を、その言語で出す。 */
export function render(language: Language, m: Message): string {
  if (!m.params) return loose(language, m.key);
  const params: Record<string, string | number> = {};
  for (const [name, v] of Object.entries(m.params)) params[name] = isMessage(v) ? render(language, v) : v;
  return loose(language, m.key, params);
}

/**
 * 利用者に見せる文を持つ失敗。
 * `message` は既定の言語（日本語）の文にしておく。ログと、言語を知らない呼び手は、今までどおりそれを読む。
 * 境目は `errorText()` で、そのときの言語の文にして出す。
 * 文字列で作ったものは、言語を選べないので、その文字列をそのまま出す。
 */
export class MessageError extends Error {
  readonly text: Message | null;
  constructor(text: Message | string) {
    super(typeof text === 'string' ? text : render(DEFAULT_LANGUAGE, text));
    this.text = typeof text === 'string' ? null : text;
  }
}

/** 失敗を、その言語の 1 つの文にする。辞書の文を持たない失敗は `message` を返す。 */
export function errorText(language: Language, e: unknown): string {
  if (e instanceof MessageError && e.text) return render(language, e.text);
  return e instanceof Error ? e.message : String(e);
}

/** 引くたびに、そのときの言語を読む `t()`。経路や道具は、受け取った言語の関数をこれに包んで使う。 */
export function translatorOf(language: GetLanguage = defaultLanguage): Translate {
  return ((key, ...args) => t(language(), key, ...args)) as Translate;
}
