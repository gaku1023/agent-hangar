import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { STATUSLINE_MARKER } from '@agent-hangar/server';
import { runStatuslineInstall } from './statusline.ts';

function claudeDir(command: string | null, script = '#!/bin/bash\necho x\n') {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-cli-sl-'));
  const dir = path.join(home, '.claude');
  fs.mkdirSync(dir);
  const file = path.join(dir, 'sl.sh');
  fs.writeFileSync(file, script);
  if (command) fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ statusLine: { type: 'command', command: command.replace('<file>', file) } }));
  return { home, dir, file };
}

describe('runStatuslineInstall', () => {
  it('承諾すれば追記し、断れば触らない', async () => {
    const a = claudeDir('<file>');
    const log: string[] = [];
    const r = await runStatuslineInstall({ claudeDir: a.dir, port: 4177, yes: false, ask: async () => true, log: (s) => log.push(s) });
    expect(r.installed).toBe(true);
    expect(fs.readFileSync(a.file, 'utf8')).toContain(STATUSLINE_MARKER);
    expect(log.join('\n')).toContain('バックアップ');
    const b = claudeDir('<file>');
    const r2 = await runStatuslineInstall({ claudeDir: b.dir, port: 4177, yes: false, ask: async () => false, log: () => {} });
    expect(r2.installed).toBe(false);
    expect(fs.readFileSync(b.file, 'utf8')).not.toContain(STATUSLINE_MARKER);
    fs.rmSync(a.home, { recursive: true, force: true });
    fs.rmSync(b.home, { recursive: true, force: true });
  });

  it('--yes は問わずに追記し、追記済みなら何もしない', async () => {
    const a = claudeDir('<file>');
    const r = await runStatuslineInstall({
      claudeDir: a.dir,
      port: 4177,
      yes: true,
      ask: async () => {
        throw new Error('asked');
      },
      log: () => {},
    });
    expect(r.installed).toBe(true);
    const r2 = await runStatuslineInstall({ claudeDir: a.dir, port: 4177, yes: true, log: () => {} });
    expect(r2).toEqual({ installed: true, message: '既に追記されています' });
    fs.rmSync(a.home, { recursive: true, force: true });
  });

  it('古い形のスニペットは、承諾を得て差し替える', async () => {
    // 目印だけ見て「既に追記されています」で終わると、トークンを argv に載せる古い形が残り続ける。
    const old = [
      STATUSLINE_MARKER,
      '__hangar_input=$(cat)',
      '__hangar_home="${HANGAR_HOME:-$HOME/.agent-hangar}"',
      `printf '%s' "$__hangar_input" | curl -s -m 0.3 -X POST \\`,
      `  -H 'Content-Type: application/json' \\`,
      '  -H "Authorization: Bearer $(cat "$__hangar_home/token" 2>/dev/null)" \\',
      '  --data-binary @- http://127.0.0.1:4177/api/ingest/statusline >/dev/null 2>&1 &',
      'exec <<<"$__hangar_input"',
      '',
    ].join('\n');
    const a = claudeDir('<file>', `#!/bin/bash\n${old}echo x\n`);
    const log: string[] = [];
    const asked: string[] = [];
    const r = await runStatuslineInstall({ claudeDir: a.dir, port: 4177, yes: false, ask: async (q) => { asked.push(q); return true; }, log: (s) => log.push(s) });
    expect(r.installed).toBe(true);
    expect(asked).toHaveLength(1);
    expect(fs.readFileSync(a.file, 'utf8')).not.toContain('Bearer $(cat');
    expect(fs.readFileSync(a.file, 'utf8')).toContain('--expand-header');
    expect(log.join('\n')).toContain('バックアップ');
    // 断れば触らない。
    const b = claudeDir('<file>', `#!/bin/bash\n${old}echo x\n`);
    const r2 = await runStatuslineInstall({ claudeDir: b.dir, port: 4177, yes: false, ask: async () => false, log: () => {} });
    expect(r2.installed).toBe(false);
    expect(fs.readFileSync(b.file, 'utf8')).toContain('Bearer $(cat');
    fs.rmSync(a.home, { recursive: true, force: true });
    fs.rmSync(b.home, { recursive: true, force: true });
  });

  it('スクリプトが見つからなければ手順を印字して終わる', async () => {
    const a = claudeDir('npx something');
    const log: string[] = [];
    const r = await runStatuslineInstall({ claudeDir: a.dir, port: 4177, yes: true, log: (s) => log.push(s) });
    expect(r.installed).toBe(false);
    expect(log.join('\n')).toContain(STATUSLINE_MARKER);
    expect(log.join('\n')).toContain('npx something');
    fs.rmSync(a.home, { recursive: true, force: true });
  });
});
