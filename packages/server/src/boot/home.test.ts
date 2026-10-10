import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DbBackupError } from '../db/backup.ts';
import { DbTooOldError } from '../db/open.ts';
import { copyFixtureClaudeDir } from '../../test/fixtures.ts';
import { BASELINE_DB_VERSION, dbVersionOf, LATEST_DB_VERSION, seedDbAt } from '../../test/oldDb.ts';
import { expectMode } from '../../test/platform.ts';
import { bootHome } from './home.ts';

describe('置き場の用意', () => {
  let home: string;
  let claudeDir: string;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-home-'));
    claudeDir = copyFixtureClaudeDir();
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(claudeDir, { recursive: true, force: true });
  });
  const tokenOf = () => fs.readFileSync(path.join(home, 'token'), 'utf8').trim();

  it('起点より古い DB は、置き場の物を書く前に断る（トークンも設定も包みも作らない）', () => {
    seedDbAt(path.join(home, 'hangar.db'), BASELINE_DB_VERSION - 1);
    fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ syncClaudeConfig: true }));
    expect(() => bootHome({ home, claudeDir })).toThrow(DbTooOldError);
    expect(fs.readdirSync(home).sort()).toEqual(['hangar.db', 'settings.json']);
    expect(fs.readFileSync(path.join(home, 'settings.json'), 'utf8')).toBe(JSON.stringify({ syncClaudeConfig: true }));
  });

  it('DB の控えが取れなければ、マイグレーションを当てずに起動を止める', () => {
    // 1 つ前の版までの DB を置き、控えの置き場（backups/db）を通常のファイルにして作れなくする。
    const file = path.join(home, 'hangar.db');
    seedDbAt(file, LATEST_DB_VERSION - 1);
    fs.mkdirSync(path.join(home, 'backups'), { recursive: true });
    fs.writeFileSync(path.join(home, 'backups', 'db'), 'x');
    expect(() => bootHome({ home, claudeDir })).toThrow(DbBackupError);
    expect(dbVersionOf(file)).toBe(LATEST_DB_VERSION - 1);
  });

  it('起動でヘッダのファイルを用意する。~/.agent-hangar を消しても使用量が静かに止まらない', () => {
    // statusline はヘッダのファイルが読めなければ何も送らない。
    // 置き場ごと消した利用者のために、トークンと同じところで起動のたびに用意する。
    const header = path.join(home, 'statusline-header');
    expect(fs.existsSync(header)).toBe(false);
    const h = bootHome({ home, claudeDir });
    try {
      expect(h.token).toBe(tokenOf());
      expect(fs.readFileSync(header, 'utf8')).toBe(`Authorization: Bearer ${tokenOf()}\n`);
      expectMode(header, 0o600);
    } finally {
      h.stop();
    }
  });

  it('トークンを作り直すと、ヘッダのファイルも次の起動で揃う', () => {
    const header = path.join(home, 'statusline-header');
    bootHome({ home, claudeDir }).stop();
    const old = tokenOf();
    fs.rmSync(path.join(home, 'token'));
    const second = bootHome({ home, claudeDir });
    try {
      expect(tokenOf()).not.toBe(old);
      expect(fs.readFileSync(header, 'utf8')).toBe(`Authorization: Bearer ${tokenOf()}\n`);
    } finally {
      second.stop();
    }
  });

  it('claudeDir を渡すと settings ではなくそれを読む', () => {
    fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ claudeDir: '/from/settings' }));
    const given = bootHome({ home, claudeDir });
    given.stop();
    expect(given.claudeDir).toBe(claudeDir);
    const fromSettings = bootHome({ home });
    fromSettings.stop();
    expect(fromSettings.claudeDir).toBe('/from/settings');
  });

  it('言語の関数は 1 つで、いまの設定の language を読む', () => {
    const h = bootHome({ home, claudeDir });
    try {
      // 項目の無い設定は日本語として読む。
      expect(h.language()).toBe('ja');
      // 設定は書き替わるので、呼ばれた時点の値を読む。
      h.settings.current = { ...h.settings.current, language: 'en' };
      expect(h.language()).toBe('en');
    } finally {
      h.stop();
    }
    fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ language: 'en' }));
    const saved = bootHome({ home, claudeDir });
    saved.stop();
    expect(saved.language()).toBe('en');
  });

  it('起こし直しても、同じ端末として立ち上がる', () => {
    const first = bootHome({ home, claudeDir });
    first.stop();
    const second = bootHome({ home, claudeDir });
    second.stop();
    expect(second.device).toEqual(first.device);
    expect(second.token).toBe(first.token);
  });

  it('設定は探した道具のパスを、起動が通ってから（persistSettings）書き戻し、寿命の印は倒したまま返す', () => {
    const h = bootHome({ home, claudeDir });
    try {
      expect(h.life).toEqual({ started: false, closed: false });
      // bootHome は設定を書かない。起動を断るときに利用者のファイルを書き換えないためである。
      expect(fs.existsSync(path.join(home, 'settings.json'))).toBe(false);
      h.persistSettings();
      const saved = JSON.parse(fs.readFileSync(path.join(home, 'settings.json'), 'utf8')) as Record<string, unknown>;
      expect(saved.tmuxPath).toBe(h.settings.current.tmuxPath);
      // 起動の包みも、ここで置く。
      expect(fs.readdirSync(home)).toEqual(expect.arrayContaining(['token', 'hangar.db', 'settings.json']));
    } finally {
      h.stop();
    }
  });
});
