import { MessageError, type Message } from '../i18n/message.ts';

/**
 * HTTP の状態コードを持つ失敗。呼び手はそのまま応答に使える。
 * 文は辞書の鍵と引数（`msg()`）で渡す。経路と MCP の道具が、そのときの言語で出す。
 * body は、応答の本文に error と並べて載せる項目である。画面が断られた理由を見分けて、確認を出すのに使う。
 */
export class RunError extends MessageError {
  constructor(readonly status: 400 | 404 | 409, text: Message | string, readonly body?: Readonly<Record<string, string | number>>) {
    super(text);
    this.name = 'RunError';
  }
}
