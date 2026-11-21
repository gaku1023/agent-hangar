import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildUnit, installService, uninstallService, type CommandResult, type Runner, type ServiceOptions } from './service.ts';

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-service-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

const ok: CommandResult = { code: 0, stdout: '', stderr: '' };

function recorder(fail: (cmd: string, args: string[]) => boolean = () => false): { run: Runner; calls: string[] } {
  const calls: string[] = [];
  const run: Runner = (cmd, args) => { calls.push([cmd, ...args].join(' ')); return fail(cmd, args) ? { code: 1, stdout: '', stderr: 'denied' } : ok; };
  return { run, calls };
}

function opts(over: Partial<ServiceOptions> & { run: Runner }): ServiceOptions {
  return {
    scope: 'user', ephemeral: false, platform: 'linux', uid: 1000, userName: 'hangar', home: tmp,
    nodePath: '/opt/hangar/node/bin/node', serverArgs: ['/opt/hangar/server.mjs'], workingDir: '/opt/hangar',
    envPath: '/home/hangar/.local/bin:/usr/bin', uiDist: undefined, log: () => {}, ...over,
  };
}

describe('buildUnit', () => {
  const base = { scope: 'user' as const, userName: 'hangar', nodePath: '/n/node', serverArgs: ['/s/server.mjs'], workingDir: '/s', envPath: '/usr/bin', ephemeral: false };

  it('tmux の会話をユニットの再起動で道連れにしないよう、KillMode=process にする', () => {
    expect(buildUnit(base)).toMatch(/^KillMode=process$/m);
  });

  it('hangar start を通さず、サーバを直に起こす（鍵付き URL を印字しない）', () => {
    const u = buildUnit(base);
    expect(u).toContain('ExecStart=/n/node /s/server.mjs');
    expect(u).not.toContain('hangar start');
  });

  it('ユーザユニットは default.target に結び、User= を持たない', () => {
    const u = buildUnit(base);
    expect(u).toMatch(/^WantedBy=default.target$/m);
    expect(u).not.toMatch(/^User=/m);
  });

  it('システムユニットは User= と multi-user.target を持つ', () => {
    const u = buildUnit({ ...base, scope: 'system' });
    expect(u).toMatch(/^User=hangar$/m);
    expect(u).toMatch(/^WantedBy=multi-user.target$/m);
  });

  it('PATH を控え、UI の置き場があれば HANGAR_UI_DIST に渡す', () => {
    const u = buildUnit({ ...base, envPath: '/a:/b', uiDist: '/s/ui' });
    expect(u).toContain('Environment=PATH=/a:/b');
    expect(u).toContain('Environment=HANGAR_UI_DIST=/s/ui');
  });

  it('ephemeral は置き場を実行時の領域（再起動で消える）に置き、端末 ID を引き継がない', () => {
    const user = buildUnit({ ...base, ephemeral: true });
    expect(user).toContain('Environment=HANGAR_HOME=%t/hangar');
    const system = buildUnit({ ...base, scope: 'system', ephemeral: true });
    expect(system).toContain('RuntimeDirectory=hangar');
    expect(system).toContain('Environment=HANGAR_HOME=/run/hangar');
    expect(buildUnit(base)).not.toContain('HANGAR_HOME');
  });

  it('空白を含む引数は引用符で包む', () => {
    expect(buildUnit({ ...base, serverArgs: ['/my dir/server.mjs'] })).toContain('ExecStart=/n/node "/my dir/server.mjs"');
  });
});

describe('installService', () => {
  it('Linux 以外では断り、何も実行しない', () => {
    const { run, calls } = recorder();
    const r = installService(opts({ run, platform: 'darwin' }));
    expect(r.ok).toBe(false);
    expect(calls).toEqual([]);
  });

  it('root では断り、非 root 利用者の作り方を案内する', () => {
    const { run, calls } = recorder();
    const msgs: string[] = [];
    const r = installService(opts({ run, uid: 0, log: (s) => msgs.push(s) }));
    expect(r.ok).toBe(false);
    expect(calls).toEqual([]);
    expect(msgs.join('\n')).toContain('useradd');
  });

  it('systemd が無ければ断る', () => {
    const { run } = recorder((cmd) => cmd === 'systemctl');
    expect(installService(opts({ run })).ok).toBe(false);
  });

  it('ユーザユニットは ~/.config/systemd/user に書き、有効化して linger を立てる', () => {
    const { run, calls } = recorder();
    const r = installService(opts({ run }));
    expect(r.ok).toBe(true);
    const file = path.join(tmp, '.config/systemd/user/hangar.service');
    expect(fs.readFileSync(file, 'utf8')).toContain('KillMode=process');
    expect(calls).toContain('systemctl --user daemon-reload');
    expect(calls).toContain('systemctl --user enable --now hangar.service');
    expect(calls).toContain('loginctl enable-linger hangar');
  });

  it('linger が立てられなくても、ユニットは入り、案内を出す', () => {
    const { run } = recorder((cmd) => cmd === 'loginctl');
    const msgs: string[] = [];
    const r = installService(opts({ run, log: (s) => msgs.push(s) }));
    expect(r.ok).toBe(true);
    expect(msgs.join('\n')).toContain('enable-linger');
  });

  it('linger が既に立っていれば、enable-linger を打たず案内も出さない', () => {
    const calls: string[] = [];
    const run: Runner = (cmd, args) => { calls.push([cmd, ...args].join(' ')); return { code: 0, stdout: args.includes('show-user') ? 'yes\n' : '', stderr: '' }; };
    const msgs: string[] = [];
    expect(installService(opts({ run, log: (s) => msgs.push(s) })).ok).toBe(true);
    expect(calls.some((c) => c.includes('enable-linger'))).toBe(false);
    expect(msgs.join('\n')).not.toContain('enable-linger');
  });

  it('システムユニットは一時ファイルを作り、sudo で /etc/systemd/system に置く', () => {
    const { run, calls } = recorder();
    const r = installService(opts({ run, scope: 'system' }));
    expect(r.ok).toBe(true);
    expect(calls.some((c) => c.startsWith('sudo install -m 644 ') && c.endsWith('/etc/systemd/system/hangar.service'))).toBe(true);
    expect(calls).toContain('sudo systemctl daemon-reload');
    expect(calls).toContain('sudo systemctl enable --now hangar.service');
    expect(calls.some((c) => c.includes('enable-linger'))).toBe(false);
  });

  it('有効化に失敗したら ok:false で、理由を出す', () => {
    const { run } = recorder((cmd, args) => args.includes('enable'));
    const msgs: string[] = [];
    const r = installService(opts({ run, log: (s) => msgs.push(s) }));
    expect(r.ok).toBe(false);
    expect(msgs.join('\n')).toContain('denied');
  });

  it('終わりに、トークン付き URL は hangar url で出すことを案内する', () => {
    const { run } = recorder();
    const msgs: string[] = [];
    installService(opts({ run, log: (s) => msgs.push(s) }));
    expect(msgs.join('\n')).toContain('hangar url');
  });

  it('ephemeral のときの案内は、hangar url に HANGAR_HOME が要ることを添える', () => {
    const { run } = recorder();
    const msgs: string[] = [];
    installService(opts({ run, ephemeral: true, log: (s) => msgs.push(s) }));
    expect(msgs.join('\n')).toContain('HANGAR_HOME');
  });
});

describe('uninstallService', () => {
  it('止めて無効にし、ユニットを消す。データの置き場には触れない', () => {
    const { run, calls } = recorder();
    installService(opts({ run }));
    const data = path.join(tmp, '.agent-hangar');
    fs.mkdirSync(data);
    const r = uninstallService(opts({ run }));
    expect(r.ok).toBe(true);
    expect(fs.existsSync(path.join(tmp, '.config/systemd/user/hangar.service'))).toBe(false);
    expect(fs.existsSync(data)).toBe(true);
    expect(calls).toContain('systemctl --user disable --now hangar.service');
  });

  it('入っていなければ ok のまま、何もしない', () => {
    const { run } = recorder();
    expect(uninstallService(opts({ run })).ok).toBe(true);
  });
});
