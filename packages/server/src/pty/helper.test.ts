import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { fixSpawnHelpers } from './helper.ts';

describe('fixSpawnHelpers', () => {
  it('実行権限の無い spawn-helper を 755 にし、直したものだけ返す', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-pty-'));
    const a = path.join(root, 'prebuilds', 'darwin-arm64', 'spawn-helper');
    const b = path.join(root, 'prebuilds', 'darwin-x64', 'spawn-helper');
    fs.mkdirSync(path.dirname(a), { recursive: true }); fs.mkdirSync(path.dirname(b), { recursive: true });
    fs.writeFileSync(a, '', { mode: 0o644 });
    fs.writeFileSync(b, '', { mode: 0o755 });
    expect(fixSpawnHelpers(root)).toEqual([a]);
    expect(fs.statSync(a).mode & 0o777).toBe(0o755);
    expect(fixSpawnHelpers(root)).toEqual([]);
    expect(fixSpawnHelpers('/nonexistent')).toEqual([]);
    fs.rmSync(root, { recursive: true, force: true });
  });
});
