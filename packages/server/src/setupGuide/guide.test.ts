import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bundledGuideDir, guideHeader, guideSha, readSetupGuide, SETUP_GUIDE_FILES, stampGuide, syncSetupGuide } from './guide.ts';

let home: string;
let src: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-guide-home-'));
  src = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-guide-src-'));
  fs.writeFileSync(path.join(src, 'setup-guide.md'), '# 手引き\n\n本文\n');
  fs.writeFileSync(path.join(src, 'setup-guide-habits.md'), '# 習慣\n');
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(src, { recursive: true, force: true });
});

const sha8 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 8);

describe('版とハッシュの行', () => {
  it('ハッシュは本文の sha256 の先頭 8 桁で、版の行は HTML の注釈 1 行である', () => {
    expect(guideSha('abc')).toBe(sha8('abc'));
    expect(guideSha('abc')).toMatch(/^[0-9a-f]{8}$/);
    expect(guideHeader('0.7.0', '3f9a1c2e')).toBe('<!-- hangar-setup-guide v0.7.0 sha256:3f9a1c2e -->');
  });

  it('写す中身は、先頭に版の行を置き、その下に本文をそのまま続ける。ハッシュは版の行を除いた本文で計算する', () => {
    const body = '# 手引き\n\n本文\n';
    const s = stampGuide(body, '0.7.0');
    expect(s.sha).toBe(sha8(body));
    expect(s.text).toBe(`<!-- hangar-setup-guide v0.7.0 sha256:${sha8(body)} -->\n${body}`);
    // 写した md の 2 行目から末尾までを計算し直すと、版の行のハッシュと一致する。
    expect(sha8(s.text.slice(s.text.indexOf('\n') + 1))).toBe(s.sha);
  });
});

describe('写し（syncSetupGuide）', () => {
  it('2 つの md を置き場へ写し、どれも先頭に版の行を持つ', () => {
    const r = syncSetupGuide(home, { version: '0.7.0', sourceDir: src });
    expect(r.map((x) => path.basename(x.file))).toEqual([...SETUP_GUIDE_FILES]);
    for (const name of SETUP_GUIDE_FILES) {
      const body = fs.readFileSync(path.join(src, name), 'utf8');
      expect(fs.readFileSync(path.join(home, name), 'utf8')).toBe(`${guideHeader('0.7.0', sha8(body))}\n${body}`);
    }
    expect(r.every((x) => x.written)).toBe(true);
  });

  it('中身が同じなら書かない（冪等）', () => {
    syncSetupGuide(home, { version: '0.7.0', sourceDir: src });
    const file = path.join(home, 'setup-guide.md');
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(file, old, old);
    const before = fs.statSync(file).mtimeMs;
    const r = syncSetupGuide(home, { version: '0.7.0', sourceDir: src });
    expect(r.every((x) => !x.written)).toBe(true);
    expect(fs.statSync(file).mtimeMs).toBe(before);
  });

  it('利用者が書き換えたものも、版が変わったものも上書きする（正本は同梱物）', () => {
    syncSetupGuide(home, { version: '0.7.0', sourceDir: src });
    const file = path.join(home, 'setup-guide.md');
    fs.writeFileSync(file, '書き換えた\n');
    expect(syncSetupGuide(home, { version: '0.7.0', sourceDir: src })[0]!.written).toBe(true);
    expect(fs.readFileSync(file, 'utf8')).toContain('本文');
    const r = syncSetupGuide(home, { version: '0.7.1', sourceDir: src });
    expect(r[0]!.written).toBe(true);
    expect(fs.readFileSync(file, 'utf8').split('\n')[0]).toBe(guideHeader('0.7.1', r[0]!.sha));
  });

  it('置き場が無ければ作る', () => {
    const nested = path.join(home, 'a', 'b');
    syncSetupGuide(nested, { version: '0.7.0', sourceDir: src });
    expect(fs.existsSync(path.join(nested, 'setup-guide.md'))).toBe(true);
  });

  it('同梱の md が無ければ投げ、置き場には何も書かない', () => {
    fs.rmSync(path.join(src, 'setup-guide-habits.md'));
    expect(() => syncSetupGuide(home, { version: '0.7.0', sourceDir: src })).toThrow();
    expect(fs.readdirSync(home)).toEqual([]);
  });
});

describe('同梱の md の場所', () => {
  it('候補を順に見て、2 つの md が揃っている最初のフォルダを返す。無ければ null', () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-guide-none-'));
    try {
      expect(bundledGuideDir([empty, src])).toBe(src);
      expect(bundledGuideDir([empty])).toBeNull();
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });

  it('ソースから動かしているときは、リポジトリの docs を見つける', () => {
    const repoDocs = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../docs');
    expect(bundledGuideDir()).toBe(repoDocs);
  });
});

describe('API の答え（readSetupGuide）', () => {
  it('写したうえで、表示用のパス、版、ハッシュ、言語に合わせた一言を返す', () => {
    const r = readSetupGuide({ home, version: '0.7.0', sourceDir: src, homeDir: path.dirname(home), platform: 'darwin', language: 'ja' });
    const sha = sha8('# 手引き\n\n本文\n');
    expect(r).toEqual({
      path: `~/${path.basename(home)}/setup-guide.md`, version: '0.7.0', sha,
      prompt: `~/${path.basename(home)}/setup-guide.md（v0.7.0 sha256:${sha}）を読んで、私の環境を診断して。書き換えは私が承諾してから`,
    });
    expect(fs.existsSync(path.join(home, 'setup-guide.md'))).toBe(true);
    const en = readSetupGuide({ home, version: '0.7.0', sourceDir: src, homeDir: path.dirname(home), platform: 'darwin', language: 'en' });
    expect(en.prompt).toMatch(/^Read ~\//);
  });
});
