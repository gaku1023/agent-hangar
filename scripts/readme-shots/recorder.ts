// CDP の Page.startScreencast でコマを集め、15fps の時刻に並べて、動く WebP（img2webp）にする。
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from 'playwright';
import type { Recorder } from './kit.ts';

type Frame = { t: number; data: Buffer };
type Tools = { ffmpeg: string; img2webp: string };

const FPS = 15;
/** 3MB を超えたら、順に画質と幅を落とす。 */
const LADDER: [number, number][] = [[85, 1600], [75, 1600], [65, 1500], [55, 1400], [45, 1280]];
const MAX_BYTES = 3 * 1024 * 1024;

export async function startRecording(page: Page, tools: Tools, workDir: string, outDir: string): Promise<Recorder> {
  const cdp = await page.context().newCDPSession(page);
  const frames: Frame[] = [];
  const shot = async (): Promise<Buffer> => Buffer.from((await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 92 })).data, 'base64');
  frames.push({ t: Date.now(), data: await shot() });
  cdp.on('Page.screencastFrame', (f) => {
    frames.push({ t: Date.now(), data: Buffer.from(f.data, 'base64') });
    void cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
  });
  const dims = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight, r: window.devicePixelRatio }));
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 92, maxWidth: dims.w * dims.r, maxHeight: dims.h * dims.r, everyNthFrame: 1 });

  return {
    async save(name, opts = {}) {
      await cdp.send('Page.stopScreencast');
      frames.push({ t: Date.now(), data: await shot() });
      const out = path.join(outDir, `${name}.webp`);
      encode(frames, out, opts.holdMs ?? 1500, tools, path.join(workDir, name));
      return out;
    },
  };
}

function encode(frames: Frame[], out: string, holdMs: number, tools: Tools, work: string): void {
  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(work, { recursive: true });
  // 15fps の目盛りごとに、その時刻までの最後のコマを選び、同じコマが続く間は 1 つにまとめる。
  const t0 = frames[0]!.t;
  const ticks = Math.ceil(((frames[frames.length - 1]!.t - t0) * FPS) / 1000) + 1;
  const groups: { frame: number; n: number }[] = [];
  let k = 0;
  for (let i = 0; i < ticks; i++) {
    const at = t0 + (i * 1000) / FPS;
    while (k + 1 < frames.length && frames[k + 1]!.t <= at) k++;
    const last = groups[groups.length - 1];
    if (last && last.frame === k) last.n++;
    else groups.push({ frame: k, n: 1 });
  }
  groups.forEach((g, i) => fs.writeFileSync(path.join(work, `s${String(i + 1).padStart(4, '0')}.jpg`), frames[g.frame]!.data));
  let size = 0;
  for (const [q, width] of LADDER) {
    const pdir = path.join(work, `p${width}`);
    if (!fs.existsSync(pdir)) {
      fs.mkdirSync(pdir);
      execFileSync(tools.ffmpeg, ['-y', '-loglevel', 'error', '-i', path.join(work, 's%04d.jpg'), '-vf', `scale=${width}:-2:flags=lanczos`, path.join(pdir, 'p%04d.png')]);
    }
    const args = ['-loop', '0', '-mixed', '-lossy', '-q', String(q)];
    groups.forEach((g, i) => {
      const ms = Math.round((g.n * 1000) / FPS) + (i === groups.length - 1 ? holdMs : 0);
      args.push('-d', String(ms), path.join(pdir, `p${String(i + 1).padStart(4, '0')}.png`));
    });
    args.push('-o', out);
    execFileSync(tools.img2webp, args);
    size = fs.statSync(out).size;
    console.log(`${path.basename(out)}  q${q} ${width}px ${groups.length} コマ ${(size / 1024 / 1024).toFixed(2)} MB`);
    if (size <= MAX_BYTES) break;
  }
  if (size > MAX_BYTES) console.warn(`${path.basename(out)} が 3MB を超えています（${(size / 1024 / 1024).toFixed(2)} MB）`);
  fs.rmSync(work, { recursive: true, force: true });
}
