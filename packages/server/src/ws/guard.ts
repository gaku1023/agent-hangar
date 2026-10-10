import type http from 'node:http';

/**
 * WebSocket の upgrade を受け付ける経路。
 * ここに無い経路は番人が切る。attach する側とこの集合が食い違うと、
 * 101 を返した直後の接続を番人が切ってしまうので、定数を正本にして両方から参照する。
 */
export const WS_PATHS = new Set(['/ws', '/ws/pty']);

/**
 * 未知の経路への upgrade を切る番人を置く。
 * 経路を握る側は path が違えば黙って返すので、握る側を全部 attach した後に、最後に置く。
 * upgrade を受けた時点でこの接続は HTTP 側の管理から外れるため、誰も引き取らないと相手が待ち続ける。
 */
export function guardUpgrades(server: Pick<http.Server, 'on'>): void {
  server.on('upgrade', (req, socket) => {
    if (!WS_PATHS.has(new URL(req.url ?? '/', 'http://x').pathname)) socket.destroy();
  });
}
