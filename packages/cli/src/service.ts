import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type ServiceScope = 'user' | 'system';

export type CommandResult = { code: number; stdout: string; stderr: string };
/** 外のコマンドを走らせる口。試験が差し替える。 */
export type Runner = (cmd: string, args: string[]) => CommandResult;

export type UnitSpec = {
  scope: ServiceScope;
  userName: string;
  nodePath: string;
  serverArgs: string[];
  workingDir: string;
  /** インストールした人の PATH。systemd の素の PATH では tmux や claude が見つからないので控える。 */
  envPath: string;
  uiDist?: string;
  ephemeral: boolean;
};

export type ServiceOptions = UnitSpec & {
  platform: NodeJS.Platform;
  uid: number;
  /** ユーザユニットの置き場の元（試験は一時ディレクトリを渡す）。 */
  home: string;
  run: Runner;
  log: (line: string) => void;
};

export const UNIT_NAME = 'hangar.service';
const SYSTEM_UNIT_PATH = `/etc/systemd/system/${UNIT_NAME}`;

/** systemd の引数の書き方に合わせ、空白か引用符を含むものだけ二重引用符で包む。 */
function quote(arg: string): string {
  return /[\s"'\\]/.test(arg) ? `"${arg.replace(/(["\\])/g, '\\$1')}"` : arg;
}

/**
 * systemd のユニットの本文。
 * サーバは hangar start を通さず直に起こす。start は鍵付きの URL を標準出力に印字し、journald に残るためである。
 * KillMode=process は、ユニットの再起動で、hangar の tmux サーバとその中の会話を道連れにしないため。
 * 既定の control-group だと、ユニットの cgroup に居る tmux ごと止まる（Docker 上の systemd で確かめた）。
 */
export function buildUnit(s: UnitSpec): string {
  const system = s.scope === 'system';
  const env: string[] = [`Environment=PATH=${s.envPath}`];
  if (s.uiDist) env.push(`Environment=HANGAR_UI_DIST=${s.uiDist}`);
  const service: string[] = [];
  if (system) service.push(`User=${s.userName}`);
  if (s.ephemeral) {
    // 置き場を再起動で消える領域に置くので、端末 ID も鍵も次の起動に引き継がれない。
    if (system) service.push('RuntimeDirectory=hangar');
    env.push(`Environment=HANGAR_HOME=${system ? '/run/hangar' : '%t/hangar'}`);
  }
  return [
    '[Unit]',
    'Description=agent-hangar server',
    'After=network-online.target',
    '',
    '[Service]',
    ...service,
    `WorkingDirectory=${s.workingDir}`,
    ...env,
    `ExecStart=${[s.nodePath, ...s.serverArgs].map(quote).join(' ')}`,
    'KillMode=process',
    'Restart=on-failure',
    'RestartSec=3',
    '',
    '[Install]',
    `WantedBy=${system ? 'multi-user.target' : 'default.target'}`,
    '',
  ].join('\n');
}

function userUnitPath(home: string): string {
  return path.join(home, '.config', 'systemd', 'user', UNIT_NAME);
}

const ROOT_NOTE = [
  'root では入れられません。Claude Code は root では全許可のモードを断るため、hangar も非 root のユーザーで動かします。',
  'ユーザーを作って、そのユーザーでインストールし直してください。',
  '  useradd -m hangar',
  '  su - hangar',
  '  hangar service install',
];

function describeFailure(r: CommandResult): string {
  return (r.stderr || r.stdout).trim() || `終了コード ${r.code}`;
}

export type ServiceResult = { ok: boolean };

export function installService(o: ServiceOptions): ServiceResult {
  const log = o.log;
  if (o.platform !== 'linux') { log('hangar service は Linux（systemd）だけで使えます。'); return { ok: false }; }
  if (o.uid === 0) { for (const l of ROOT_NOTE) log(l); return { ok: false }; }
  if (o.run('systemctl', ['--version']).code !== 0) { log('systemd が見つかりません。systemd のある Linux で実行してください。'); return { ok: false }; }

  const unit = buildUnit(o);
  const sys = o.scope === 'system';
  const exec = (args: string[]): CommandResult => (sys ? o.run('sudo', ['systemctl', ...args]) : o.run('systemctl', ['--user', ...args]));

  if (sys) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-unit-'));
    const tmp = path.join(tmpDir, UNIT_NAME);
    try {
      fs.writeFileSync(tmp, unit, { mode: 0o600 });
      const r = o.run('sudo', ['install', '-m', '644', tmp, SYSTEM_UNIT_PATH]);
      if (r.code !== 0) { log(`ユニットを ${SYSTEM_UNIT_PATH} に置けませんでした: ${describeFailure(r)}`); return { ok: false }; }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  } else {
    const file = userUnitPath(o.home);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, unit, { mode: 0o644 });
  }

  for (const args of [['daemon-reload'], ['enable', '--now', UNIT_NAME]]) {
    const r = exec(args);
    if (r.code !== 0) { log(`systemctl ${args.join(' ')} に失敗しました: ${describeFailure(r)}`); return { ok: false }; }
  }

  if (!sys) {
    // ユーザユニットは、ログアウトで止まらないよう linger が要る。
    const lingering = o.run('loginctl', ['show-user', o.userName, '-p', 'Linger', '--value']);
    const r = lingering.code === 0 && lingering.stdout.trim() === 'yes' ? lingering : o.run('loginctl', ['enable-linger', o.userName]);
    if (r.code !== 0) {
      log(`ログアウト後も動かすには、次を実行してください: sudo loginctl enable-linger ${o.userName}`);
    }
  }

  log('hangar のサーバーを常駐させました。');
  log('トークン付きの URL はログに出しません。必要なときだけ、この機械で hangar url を実行してください。');
  if (o.ephemeral) log('ephemeral のため、ディレクトリは再起動で消えます。hangar url などは同じディレクトリを見るよう、HANGAR_HOME を合わせて実行してください。');
  log('次の手順: Claude Code などの認証と初回の問いを済ませ、hangar cloud join-request でクラウドに参加します。');
  return { ok: true };
}

export function uninstallService(o: ServiceOptions): ServiceResult {
  const log = o.log;
  if (o.platform !== 'linux') { log('hangar service は Linux（systemd）だけで使えます。'); return { ok: false }; }
  if (o.uid === 0) { for (const l of ROOT_NOTE) log(l); return { ok: false }; }
  const sys = o.scope === 'system';
  const file = sys ? SYSTEM_UNIT_PATH : userUnitPath(o.home);
  if (!fs.existsSync(file)) { log('ユニットは入っていません。'); return { ok: true }; }
  const exec = (args: string[]): CommandResult => (sys ? o.run('sudo', ['systemctl', ...args]) : o.run('systemctl', ['--user', ...args]));
  exec(['disable', '--now', UNIT_NAME]);
  if (sys) {
    const r = o.run('sudo', ['rm', '-f', file]);
    if (r.code !== 0) { log(`ユニットを消せませんでした: ${describeFailure(r)}`); return { ok: false }; }
  } else {
    fs.rmSync(file, { force: true });
  }
  exec(['daemon-reload']);
  log('ユニットを解除しました。データのディレクトリ（~/.agent-hangar）は残してあります。');
  return { ok: true };
}

/** 本物のコマンドを走らせる口。 */
export const realRunner: Runner = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8' });
  return { code: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.error ? String(r.error.message) : r.stderr ?? '' };
};
