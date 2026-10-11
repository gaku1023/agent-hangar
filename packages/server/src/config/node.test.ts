import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createNodeCheck, isFullPath, nodeBuildIssue, parseNodeProbe, probeNodeBuild, readNodeNeed, type NodeCheck } from './node.ts';

// 設定の「Node のパス」の確かめ。
// 殻（apps/desktop/src-tauri/src/node.rs）は、manifest.json と同じメジャー版とアーキテクチャの Node だけを採る。
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
const running = { major: Number(process.versions.node.split('.')[0]), arch: process.arch };

describe('parseNodeProbe', () => {
  it('「メジャー版 アーキ」の行を、前後の行が混ざっても後ろから探して読む', () => {
    expect(parseNodeProbe('22 arm64\n')).toEqual({ major: 22, arch: 'arm64' });
    expect(parseNodeProbe('(node:1) Warning: something\n24 x64\r\n')).toEqual({ major: 24, arch: 'x64' });
    expect(parseNodeProbe('22 arm64\ntrailing words here\n')).toEqual({ major: 22, arch: 'arm64' });
  });
  it('Node の答えの形でなければ null', () => {
    expect(parseNodeProbe('')).toBeNull();
    expect(parseNodeProbe('v22.14.0\n')).toBeNull();
    expect(parseNodeProbe('tmux 3.4\n')).toBeNull();
    expect(parseNodeProbe('22 ARM64\n')).toBeNull();
  });
});

describe('readNodeNeed', () => {
  it('同梱の manifest.json の nodeMajor と arch を読む', () => {
    const d = tmp();
    fs.writeFileSync(path.join(d, 'manifest.json'), JSON.stringify({ version: '0.2.0', nodeMajor: 22, arch: 'arm64' }));
    expect(readNodeNeed(path.join(d, 'manifest.json'))).toEqual({ major: 22, arch: 'arm64' });
  });
  it('無い、壊れている、形が違うときは null', () => {
    const d = tmp();
    expect(readNodeNeed(path.join(d, 'manifest.json'))).toBeNull();
    fs.writeFileSync(path.join(d, 'broken.json'), '{');
    expect(readNodeNeed(path.join(d, 'broken.json'))).toBeNull();
    fs.writeFileSync(path.join(d, 'partial.json'), JSON.stringify({ nodeMajor: '22', arch: 'arm64' }));
    expect(readNodeNeed(path.join(d, 'partial.json'))).toBeNull();
  });
});

describe('createNodeCheck', () => {
  it('要る Node は manifest.json のもの。無ければ（ソースから動かしているとき）サーバを動かしている Node', () => {
    const d = tmp();
    fs.writeFileSync(path.join(d, 'manifest.json'), JSON.stringify({ nodeMajor: 22, arch: 'x64' }));
    expect(createNodeCheck({ manifestFile: path.join(d, 'manifest.json') }).need()).toEqual({ major: 22, arch: 'x64' });
    expect(createNodeCheck({ manifestFile: path.join(d, 'none.json') }).need()).toEqual(running);
  });
  it('実物の Node を起こして、メジャー版とアーキを読む', async () => {
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
  const check = (found: { major: number; arch: string } | null): NodeCheck => ({ need: () => ({ major: 22, arch: 'arm64' }), probe: async () => found });
  it('メジャー版とアーキが要るものと同じなら null', async () => {
    expect(await nodeBuildIssue('/n/node', check({ major: 22, arch: 'arm64' }))).toBeNull();
  });
  it('版かアーキが違えば、見つけたものと要るものを返す。新しい版でも代わりにならない', async () => {
    expect(await nodeBuildIssue('/n/node', check({ major: 24, arch: 'arm64' }))).toEqual({ kind: 'mismatch', found: { major: 24, arch: 'arm64' }, need: { major: 22, arch: 'arm64' } });
    expect(await nodeBuildIssue('/n/node', check({ major: 22, arch: 'x64' }))).toEqual({ kind: 'mismatch', found: { major: 22, arch: 'x64' }, need: { major: 22, arch: 'arm64' } });
  });
  it('Node として答えなければ notNode', async () => {
    expect(await nodeBuildIssue('/n/node', check(null))).toEqual({ kind: 'notNode' });
  });
});
