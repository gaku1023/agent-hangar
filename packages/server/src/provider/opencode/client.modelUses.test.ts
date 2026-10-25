import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { OpencodeClient } from './client.ts';

let server: http.Server | null = null;
afterEach(async () => { await new Promise<void>((r) => { server ? server.close(() => r()) : r(); }); server = null; });

/** `/api/config` に layers を返す serve の偽物。 */
async function serveConfig(layers: unknown): Promise<OpencodeClient> {
  server = http.createServer((_req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(layers)); });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return new OpencodeClient({ url: `http://127.0.0.1:${port}`, password: 'pw' });
}

describe('OpencodeClient.modelUses', () => {
  it('2.x の層（model はオブジェクト、agents、small_model は agents.title）を読み、後の層で上書きする', async () => {
    const c = await serveConfig([
      { info: { model: { providerID: 'lmstudio', model: 'qwen' }, agents: { scout: { model: { providerID: 'lmstudio', model: 'gemma' } }, title: { model: 'lmstudio/gemma' } } } },
      { info: { agents: { scout: { model: { providerID: 'lmstudio', model: 'qwen' } }, plan: { disable: true, model: 'lmstudio/x' } } } },
    ]);
    expect(await c.modelUses('/w')).toEqual({ model: 'lmstudio/qwen', small: null, agents: [{ id: 'scout', model: 'lmstudio/qwen' }, { id: 'title', model: 'lmstudio/gemma' }] });
  });

  it('1.x の書き方（agent の model は文字列、small_model）も読む', async () => {
    const c = await serveConfig([{ info: { model: 'lmstudio/qwen', small_model: 'lmstudio/small', agent: { fetcher: { model: 'lmstudio/gemma' }, build: { mode: 'primary' } } } }]);
    expect(await c.modelUses('/w')).toEqual({ model: 'lmstudio/qwen', small: 'lmstudio/small', agents: [{ id: 'fetcher', model: 'lmstudio/gemma' }] });
  });
});
