import { describe, expect, it } from 'vitest';
import type { AccountAuthDto } from '@agent-hangar/shared';
import { remoteControlAllowed, remoteControlName, remoteControlRefusal } from './remoteControl.ts';

const claudeAi: AccountAuthDto = { loggedIn: true, email: 'user@example.com', plan: 'max', orgName: null, checkedAt: 1 };
const apiKey: AccountAuthDto = { loggedIn: true, email: null, plan: null, orgName: null, checkedAt: 1 };

describe('remoteControlAllowed', () => {
  it('設定が入で、claude.ai のログインで、環境が空なら true', () => {
    expect(remoteControlAllowed({ enabled: true, supported: true, auth: claudeAi, env: {} })).toBe(true);
    expect(remoteControlAllowed({ enabled: true, supported: true, auth: claudeAi, env: { ANTHROPIC_BASE_URL: '', ANTHROPIC_API_KEY: undefined, PATH: '/usr/bin' } })).toBe(true);
  });
  it('設定が切なら false', () => {
    expect(remoteControlAllowed({ enabled: false, supported: true, auth: claudeAi, env: {} })).toBe(false);
  });
  it('API キーの認証では false', () => {
    expect(remoteControlAllowed({ enabled: true, supported: true, auth: apiKey, env: {} })).toBe(false);
    expect(remoteControlAllowed({ enabled: true, supported: true, auth: claudeAi, env: { ANTHROPIC_API_KEY: 'sk-ant-fake' } })).toBe(false);
  });
  it('ANTHROPIC_BASE_URL があれば false', () => {
    expect(remoteControlAllowed({ enabled: true, supported: true, auth: claudeAi, env: { ANTHROPIC_BASE_URL: 'https://proxy.example.com' } })).toBe(false);
  });
  it('手元の claude の --help に --remote-control が無い（または読めていない）なら false', () => {
    expect(remoteControlAllowed({ enabled: true, supported: false, auth: claudeAi, env: {} })).toBe(false);
  });
  it('auth が null（読めない）なら false、ログインしていなくても false', () => {
    expect(remoteControlAllowed({ enabled: true, supported: true, auth: null, env: {} })).toBe(false);
    expect(remoteControlAllowed({ enabled: true, supported: true, auth: { ...claudeAi, loggedIn: false }, env: {} })).toBe(false);
  });
});

describe('remoteControlRefusal', () => {
  it('付けない理由を、どの条件で落ちたかの名前で返す。付けてよければ null', () => {
    const ok = { enabled: true, supported: true, auth: claudeAi, env: {} };
    expect(remoteControlRefusal(ok)).toBeNull();
    expect(remoteControlRefusal({ ...ok, enabled: false })).toBe('disabled');
    expect(remoteControlRefusal({ ...ok, supported: false })).toBe('unsupported');
    expect(remoteControlRefusal({ ...ok, auth: null })).toBe('auth-unknown');
    expect(remoteControlRefusal({ ...ok, auth: { ...claudeAi, loggedIn: false } })).toBe('logged-out');
    expect(remoteControlRefusal({ ...ok, auth: apiKey })).toBe('no-email');
    expect(remoteControlRefusal({ ...ok, env: { ANTHROPIC_BASE_URL: 'https://proxy.example.com' } })).toBe('base-url');
    expect(remoteControlRefusal({ ...ok, env: { ANTHROPIC_API_KEY: 'sk-ant-fake' } })).toBe('api-key');
  });
});

describe('remoteControlName', () => {
  it('名前 → 指示の先頭 40 字 → プロジェクト名の順', () => {
    expect(remoteControlName({ name: '会話 1', prompt: 'やって', projectName: 'project-a' })).toBe('会話 1');
    expect(remoteControlName({ prompt: 'x'.repeat(60), projectName: 'project-a' })).toBe('x'.repeat(40));
    expect(remoteControlName({ name: '  ', prompt: '', projectName: 'project-a' })).toBe('project-a');
  });
  it('改行を空白にして、先頭の - を外す（フラグに読まれない）', () => {
    expect(remoteControlName({ prompt: '一行目\n二行目' })).toBe('一行目 二行目');
    expect(remoteControlName({ name: '--dangerously-skip-permissions' })).toBe('dangerously-skip-permissions');
  });
  it('何も無ければ既定の名前（空のままだと続く引数を飲む）', () => {
    expect(remoteControlName({})).not.toBe('');
  });
});
