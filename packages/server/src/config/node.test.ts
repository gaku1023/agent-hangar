import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createNodeCheck, isFullPath, nodeBuildIssue, probeNodeBuild, readNodeNeed, type NodeCheck } from './node.ts';
import { NODE_API_MIN, NODE_MIN_LABEL, type NodeBuild } from './nodeRule.ts';

// 設定の「Node のパス」の確かめ。
// 殻（apps/desktop/src-tauri/src/node.rs）は、manifest.json の nodeApi 以上の Node-API を持ち、アーキテクチャが同じ Node だけを採る。
// 設定の画面が同じ条件で確かめないと、画面では ✓ なのに、次の起動で殻がその Node を使わない。

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
const tmp = (): string => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-node-'));
  dirs.push(d);
  return d;
};
const running: NodeBuild = { version: process.versions.node, napi: Number(process.versions.napi), arch: process.arch };

describe('readNodeNeed', () => {
  it('同梱の manifest.json の nodeApi、nodeMin、arch を読む', () => {
    const d = tmp();
    fs.writeFileSync(path.join(d, 'manifest.json'), JSON.stringify({ version: '0.2.0', nodeApi: 10, nodeMin: '22.14', arch: 'arm64' }));
    expect(readNodeNeed(path.join(d, 'manifest.json'))).toEqual({ napi: 10, min: '22.14', arch: 'arm64' });
  });
  it('無い、壊れている、形が違うときは null', () => {
    const d = tmp();
    expect(readNodeNeed(path.join(d, 'manifest.json'))).toBeNull();
    fs.writeFileSync(path.join(d, 'broken.json'), '{');
    expect(readNodeNeed(path.join(d, 'broken.json'))).toBeNull();
    fs.writeFileSync(path.join(d, 'partial.json'), JSON.stringify({ nodeApi: '10', nodeMin: '22.14', arch: 'arm64' }));
    expect(readNodeNeed(path.join(d, 'partial.json'))).toBeNull();
    // 0.6.0 までの形（メジャー版だけ）は読まない。
    fs.writeFileSync(path.join(d, 'old.json'), JSON.stringify({ nodeMajor: 22, arch: 'arm64' }));
    expect(readNodeNeed(path.join(d, 'old.json'))).toBeNull();
  });
});

describe('createNodeCheck', () => {
  it('要る Node は manifest.json のもの。無ければ（ソースから動かしているとき）同じ規則の既定の値と、サーバを動かしている Node のアーキ', () => {
    const d = tmp();
    fs.writeFileSync(path.join(d, 'manifest.json'), JSON.stringify({ nodeApi: 10, nodeMin: '22.14', arch: 'x64' }));
    expect(createNodeCheck({ manifestFile: path.join(d, 'manifest.json') }).need()).toEqual({ napi: 10, min: '22.14', arch: 'x64' });
    expect(createNodeCheck({ manifestFile: path.join(d, 'none.json') }).need()).toEqual({ napi: NODE_API_MIN, min: NODE_MIN_LABEL, arch: process.arch });
  });
  it('実物の Node を起こして、版、Node-API の版、アーキを読む', async () => {
    expect(await probeNodeBuild(process.execPath)).toEqual(running);
    expect(await createNodeCheck().probe(process.execPath)).toEqual(running);
  });
  it('起こせないものは null', async () => {
    expect(await probeNodeBuild(path.join(tmp(), 'no-node'))).toBeNull();
  });
});

describe('isFullPath', () => {
  it('macOS と Linux は / で始まるパスだけ', () => {
    expect(isFullPath('/opt/homebrew/bin/node', 'darwin')).toBe(true);
    for (const p of ['node', './node', 'bin/node', '~/node']) expect(isFullPath(p, 'darwin'), p).toBe(false);
  });
  it('Windows はドライブから始まるパスか UNC のパスだけ', () => {
    for (const p of ['C:\\Program Files\\nodejs\\node.exe', 'c:/nodejs/node.exe', '\\\\server\\share\\node.exe']) expect(isFullPath(p, 'win32'), p).toBe(true);
    for (const p of ['node.exe', '.\\node.exe', '\\nodejs\\node.exe', 'C:node.exe']) expect(isFullPath(p, 'win32'), p).toBe(false);
  });
});

describe('nodeBuildIssue', () => {
  const need = { napi: 10, min: '22.14', arch: 'arm64' };
  const check = (found: NodeBuild | null): NodeCheck => ({ need: () => need, probe: async () => found });
  it('Node-API が要る版以上で、アーキが同じなら null。新しい版も採る', async () => {
    expect(await nodeBuildIssue('/n/node', check({ version: '22.14.0', napi: 10, arch: 'arm64' }))).toBeNull();
    expect(await nodeBuildIssue('/n/node', check({ version: '24.21.0', napi: 10, arch: 'arm64' }))).toBeNull();
  });
  it('Node-API が足りないか、アーキが違えば、どちらかと、見つけたものと要るものを返す', async () => {
    const old = { version: '20.18.0', napi: 9, arch: 'arm64' };
    expect(await nodeBuildIssue('/n/node', check(old))).toEqual({ kind: 'mismatch', fit: 'version', found: old, need });
    const x64 = { version: '22.14.0', napi: 10, arch: 'x64' };
    expect(await nodeBuildIssue('/n/node', check(x64))).toEqual({ kind: 'mismatch', fit: 'arch', found: x64, need });
  });
  it('Node として答えなければ notNode', async () => {
    expect(await nodeBuildIssue('/n/node', check(null))).toEqual({ kind: 'notNode' });
  });
});
