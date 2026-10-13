import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { NODE_API_MIN, NODE_MIN_LABEL, NODE_PROBE_EXPR, nodeFit, nodeLtsMajor, parseNodeProbe, type NodeNeed } from './nodeRule.ts';

// Node を採るかどうかの規則。殻（node.rs）、同梱の CLI（hangar.sh、launch-cli.ts）、設定の確かめが同じ規則を使う。
// 見本の表（node-rule-cases.json）は、殻の試験と同梱の CLI の試験も読む。

type Case = { answer: string; version?: string; napi?: number; arch?: string; fit: 'ok' | 'version' | 'arch' | null };
const table = JSON.parse(fs.readFileSync(new URL('./node-rule-cases.json', import.meta.url), 'utf8')) as { need: NodeNeed; cases: Case[] };

describe('Node を採る規則', () => {
  it('要るのは Node-API 10 以上で、それは Node 22.14 以上に当たる', () => {
    expect(NODE_API_MIN).toBe(10);
    expect(NODE_MIN_LABEL).toBe('22.14');
    expect(nodeLtsMajor(NODE_MIN_LABEL)).toBe(22);
    // 見本の表も同じ値で書く。
    expect(table.need).toEqual({ napi: NODE_API_MIN, min: NODE_MIN_LABEL, arch: 'arm64' });
  });

  it('候補に訊く式は、版、アーキテクチャ、Node-API の版を 1 行に並べる', () => {
    // 実物の Node で式を評価し、読み口で読めることを確かめる。
    // eslint-disable-next-line no-new-func
    const out = String(new Function(`return ${NODE_PROBE_EXPR}`)());
    expect(parseNodeProbe(out)).toEqual({ version: process.versions.node, napi: Number(process.versions.napi), arch: process.arch });
  });

  it.each(table.cases.map((c) => [JSON.stringify(c.answer), c] as const))('%s', (_label, c) => {
    const got = parseNodeProbe(c.answer);
    if (c.fit === null) {
      expect(got).toBeNull();
      return;
    }
    expect(got).toEqual({ version: c.version, napi: c.napi, arch: c.arch });
    expect(nodeFit(got!, table.need)).toBe(c.fit);
  });

  // ソースから動かすときも、同じネイティブモジュール（Node-API 10）を読むので、リポジトリの engines を同じ版にそろえる。
  it('リポジトリの engines は、規則の版以上（>=22.14）', () => {
    const root = JSON.parse(fs.readFileSync(new URL('../../../../package.json', import.meta.url), 'utf8')) as { engines?: { node?: string } };
    expect(root.engines?.node).toBe(`>=${NODE_MIN_LABEL}`);
  });

  it('上限は付けない。新しい Node-API の版でも採る', () => {
    expect(nodeFit({ version: '30.0.0', napi: 20, arch: 'x64' }, { napi: 10, min: '22.14', arch: 'x64' })).toBe('ok');
  });
});
