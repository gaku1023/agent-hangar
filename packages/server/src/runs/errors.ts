import { MessageError, type Message } from '../i18n/message.ts';

/**
 * HTTP の状態コードを持つ失敗。呼び手はそのまま応答に使える。
 * 文は辞書の鍵と引数（`msg()`）で渡す。経路と MCP の道具が、そのときの言語で出す。
 */
export class RunError extends MessageError {
  constructor(readonly status: 400 | 404 | 409, text: Message | string) {
    super(text);
    this.name = 'RunError';
  }
}
