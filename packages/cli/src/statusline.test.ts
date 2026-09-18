import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { STATUSLINE_MARKER, statuslineHeaderPath } from '@agent-hangar/server';
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

/** hangar 自身の置き場。実物の ~/.agent-hangar には触れない。 */
const homes: string[] = [];
function hangarHome(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-cli-home-'));
  homes.push(d);
  return d;
}
afterEach(() => {
  while (homes.length) fs.rmSync(homes.pop()!, { recursive: true, force: true });
});

describe('runStatuslineInstall', () => {
  it('承諾すれば追記し、断れば触らない', async () => {
    const a = claudeDir('<file>');
    const log: string[] = [];
    const r = await runStatuslineInstall({ claudeDir: a.dir, port: 4177, yes: false, home: hangarHome(), ask: async () => true, log: (s) => log.push(s) });
    expect(r.installed).toBe(true);
    expect(fs.readFileSync(a.file, 'utf8')).toContain(STATUSLINE_MARKER);
    expect(log.join('\n')).toContain('バックアップ');
    const b = claudeDir('<file>');
    const r2 = await runStatuslineInstall({ claudeDir: b.dir, port: 4177, yes: false, home: hangarHome(), ask: async () => false, log: () => {} });
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
      home: hangarHome(),
      ask: async () => {
        throw new Error('asked');
      },
      log: () => {},
    });
    expect(r.installed).toBe(true);
    const r2 = await runStatuslineInstall({ claudeDir: a.dir, port: 4177, yes: true, home: hangarHome(), log: () => {} });
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
    const r = await runStatuslineInstall({ claudeDir: a.dir, port: 4177, yes: false, home: hangarHome(), ask: async (q) => { asked.push(q); return true; }, log: (s) => log.push(s) });
    expect(r.installed).toBe(true);
    expect(asked).toHaveLength(1);
    expect(fs.readFileSync(a.file, 'utf8')).not.toContain('Bearer $(cat');
    expect(fs.readFileSync(a.file, 'utf8')).toContain('-H @"$__hangar_header"');
    expect(log.join('\n')).toContain('バックアップ');
    // 断れば触らない。
    const b = claudeDir('<file>', `#!/bin/bash\n${old}echo x\n`);
    const r2 = await runStatuslineInstall({ claudeDir: b.dir, port: 4177, yes: false, home: hangarHome(), ask: async () => false, log: () => {} });
    expect(r2.installed).toBe(false);
    expect(fs.readFileSync(b.file, 'utf8')).toContain('Bearer $(cat');
    fs.rmSync(a.home, { recursive: true, force: true });
    fs.rmSync(b.home, { recursive: true, force: true });
  });

  it('追記する前に、ヘッダのファイルを 0600 で置く', async () => {
    // このファイルが無いと、スニペットは何も送らずに素通しする。
    const a = claudeDir('<file>');
    const home = hangarHome();
    const r = await runStatuslineInstall({ claudeDir: a.dir, port: 4177, yes: true, home, log: () => {} });
    expect(r.installed).toBe(true);
    const header = statuslineHeaderPath(home);
    const token = fs.readFileSync(path.join(home, 'token'), 'utf8').trim();
    expect(fs.readFileSync(header, 'utf8')).toBe(`Authorization: Bearer ${token}\n`);
    expect(fs.statSync(header).mode & 0o777).toBe(0o600);
    // スクリプトに書くのはファイルの名前だけで、トークンそのものは書かない。
    expect(fs.readFileSync(a.file, 'utf8')).not.toContain(token);
    fs.rmSync(a.home, { recursive: true, force: true });
  });

  it('スクリプトが見つからなくても、ヘッダのファイルは置く', async () => {
    // 手でスニペットを入れる人にも、置き場だけは用意しておく。
    const a = claudeDir('npx something');
    const home = hangarHome();
    const r = await runStatuslineInstall({ claudeDir: a.dir, port: 4177, yes: true, home, log: () => {} });
    expect(r.installed).toBe(false);
    expect(fs.existsSync(statuslineHeaderPath(home))).toBe(true);
    fs.rmSync(a.home, { recursive: true, force: true });
  });

  it('スクリプトが見つからなければ手順を印字して終わる', async () => {
    const a = claudeDir('npx something');
    const log: string[] = [];
    const r = await runStatuslineInstall({ claudeDir: a.dir, port: 4177, yes: true, home: hangarHome(), log: (s) => log.push(s) });
    expect(r.installed).toBe(false);
    expect(log.join('\n')).toContain(STATUSLINE_MARKER);
    expect(log.join('\n')).toContain('npx something');
    fs.rmSync(a.home, { recursive: true, force: true });
  });
});
