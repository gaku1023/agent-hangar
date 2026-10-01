/** HTTP の状態コードを持つ失敗。呼び手はそのまま応答に使える。 */
export class RunError extends Error {
  constructor(readonly status: 400 | 404 | 409, message: string) {
    super(message);
    this.name = 'RunError';
  }
}
