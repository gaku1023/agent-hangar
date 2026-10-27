import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { COMMON_WATCH, matcher } from '../../../scripts/readme-shots/watch.ts';

// README の画像（docs/images）と、撮る台本（scripts/readme-shots/scenes）と、撮った記録（docs/images/shots.json）のつじつまの試験。
// 画像は撮らない。場面のファイルは import せず、kind と watch を文字から読む（作りかけの場面や撮影の道具に引きずられないため）。

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (rel: string): string => fs.readFileSync(path.join(repo, rel), 'utf8');

const scenesDir = 'scripts/readme-shots/scenes';
// run.ts と同じ規則：_ か . で始まる、または名前に . を含むファイルは場面でない。
const sceneFiles = fs.readdirSync(path.join(repo, scenesDir)).filter((f) => /^[^_.][^.]*\.ts$/.test(f)).sort();
const scenes = sceneFiles.map((f) => {
  const src = read(`${scenesDir}/${f}`);
  const name = /^\s*name: '([^']+)',\s*\n\s*kind: '(motion|still)'/m.exec(src);
  const block = /^\s*watch: \[([\s\S]*?)\n\s*\],/m.exec(src);
  return {
    file: f.replace(/\.ts$/, ''),
    name: name?.[1],
    kind: name?.[2] as 'motion' | 'still' | undefined,
    watch: block ? [...block[1]!.matchAll(/'([^']+)'/g)].map((m) => m[1]!) : [],
  };
});
const expectedImage = (s: { name?: string; kind?: string }): string => `${s.name}.${s.kind === 'motion' ? 'webp' : 'png'}`;

const imageDir = path.join(repo, 'docs/images');
const images = fs.readdirSync(imageDir).filter((f) => /\.(webp|png|gif|jpe?g|svg)$/.test(f)).sort();

describe('README の画像', () => {
  const readme = read('README.md');
  const referenced = [...readme.matchAll(/docs\/images\/([^\s"')]+)/g)].map((m) => m[1]!);

  it('README が参照する docs/images の画像は、すべてある', () => {
    expect(referenced.length).toBeGreaterThan(0);
    expect(referenced.filter((f) => !fs.existsSync(path.join(imageDir, f)))).toEqual([]);
  });

  it('docs/images の画像は、すべて README から参照されている', () => {
    expect(images.filter((f) => !referenced.includes(f))).toEqual([]);
  });
});

describe('台本の場面', () => {
  it('場面の name はファイル名と同じで、kind が読める', () => {
    for (const s of scenes) {
      expect(s.name, `${s.file}.ts の name`).toBe(s.file);
      expect(s.kind, `${s.file}.ts の kind`).toBeDefined();
    }
  });

  it('場面と docs/images の画像が 1 対 1（motion は .webp、still は .png）', () => {
    expect(images).toEqual(scenes.map(expectedImage).sort());
  });

  it('shots.json に全場面の行があり、行の file が画像と合う', () => {
    const shots = JSON.parse(read('docs/images/shots.json')) as Record<string, { commit: string; shotAt: string; file: string; bytes: number }>;
    expect(Object.keys(shots).sort()).toEqual(scenes.map((s) => s.name).sort());
    for (const s of scenes) {
      const row = shots[s.name!]!;
      expect(row.file).toBe(`docs/images/${expectedImage(s)}`);
      expect(row.commit).toMatch(/^[0-9a-f]{40}$/);
      expect(Number.isNaN(Date.parse(row.shotAt))).toBe(false);
      expect(row.bytes).toBeGreaterThan(0);
    }
  });

  it('watch が空でなく、書いた指定がどれも追跡中のファイルに当たる', () => {
    const tracked = execFileSync('git', ['ls-files'], { cwd: repo, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\n').filter(Boolean);
    const dead: string[] = [];
    for (const s of scenes) {
      expect(s.watch.length, `${s.file}.ts の watch`).toBeGreaterThan(0);
      for (const pat of s.watch) if (!tracked.some(matcher([pat]))) dead.push(`${s.file}: ${pat}`);
    }
    for (const pat of COMMON_WATCH) if (!tracked.some(matcher([pat]))) dead.push(`共通: ${pat}`);
    expect(dead).toEqual([]);
  });

  it('matcher は glob とディレクトリを読み、試験のファイルは数えない', () => {
    const m = matcher(['a/{x,y}.ts', 'b/*.ts', 'c']);
    expect(m('a/x.ts')).toBe(true);
    expect(m('a/z.ts')).toBe(false);
    expect(m('b/q.ts')).toBe(true);
    expect(m('b/sub/q.ts')).toBe(false);
    expect(m('c/deep/file.css')).toBe(true);
    expect(m('b/q.test.ts')).toBe(false);
  });
});
