import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect } from 'vitest';
import { readFakeOpencodeLog, writeFakeOpencode, type FakeOpencodeOptions } from '../../../test/fake-opencode.ts';
import { posixDescribe, posixIt } from '../../../test/platform.ts';
import { OpencodeExporter, opencodeExportDir } from './export.ts';

const SES = 'ses_f55764078ffeDvMj180Fvan87g';
const exportOf = (id: string, text = 'hello') => ({ info: { id, title: 't' }, messages: [{ info: { id: 'msg_1' }, parts: [{ type: 'text', text }] }] });

// 偽の opencode は sh の台本から node を起こす。Windows での書き出しは段 G で確かめる。
posixDescribe('OpencodeExporter', () => {
  let dir: string;
  let home: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-ocx-'));
    home = path.join(dir, 'home');
  });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  const make = (opts: FakeOpencodeOptions, o: { serve?: { url: string; password: string } | null; bin?: string | null } = {}) => {
    const fake = writeFakeOpencode(path.join(dir, 'bin'), opts);
    const exporter = new OpencodeExporter({
      home,
      bin: () => (o.bin === undefined ? fake.bin : o.bin),
      serveOf: () => o.serve ?? null,
      // 呼び手（hangar のサーバ）の環境に印が混ざっていても、書き出しの opencode には渡さない。
      env: { HOME: home, USER: 'me', PATH: '/usr/bin:/bin', CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'x', HANGAR_TOKEN: 'secret', ANTHROPIC_API_KEY: 'sk' },
      lockDelaysMs: [10, 10, 10],
      log: () => undefined,
    });
    return { exporter, log: () => readFakeOpencodeLog(fake.logFile) };
  };
  const leftovers = () => fs.readdirSync(opencodeExportDir(home)).filter((f) => f !== `${SES}.json`);

  posixIt('serve が無ければ --standalone で書き出し、~/.agent-hangar/opencode/export/<会話>.json に置く', async () => {
    const { exporter, log } = make({ exports: { [SES]: exportOf(SES) } });
    const file = await exporter.export(SES);
    expect(file).toBe(path.join(home, 'opencode', 'export', `${SES}.json`));
    expect(JSON.parse(fs.readFileSync(file!, 'utf8'))).toEqual(exportOf(SES));
    // 本文が入るので、自分だけが読める。
    expect(fs.statSync(file!).mode & 0o777).toBe(0o600);
    expect(fs.statSync(opencodeExportDir(home)).mode & 0o777).toBe(0o700);
    const start = log().find((e) => e.ev === 'start');
    if (start?.ev !== 'start') throw new Error('no start');
    expect(start.argv).toEqual(['session', 'export', '--standalone', SES]);
    expect(log().filter((e) => e.ev === 'export')).toMatchObject([{ via: 'standalone', id: SES }]);
    expect(leftovers()).toEqual([]);
  });

  posixIt('空の環境から起こす。呼び手の印も API キーも渡さない', async () => {
    const { exporter, log } = make({ exports: { [SES]: exportOf(SES) } });
    await exporter.export(SES);
    const start = log().find((e) => e.ev === 'start');
    if (start?.ev !== 'start') throw new Error('no start');
    // sh と OS が足す鍵（PWD、SHLVL、macOS の __CF_USER_TEXT_ENCODING など）のほかは、決まった鍵だけである。
    const keys = Object.keys(start.env).filter((k) => !['PWD', 'SHLVL', '_', 'OLDPWD', '__CF_USER_TEXT_ENCODING'].includes(k));
    expect(keys.sort()).toEqual(['HOME', 'LANG', 'PATH', 'USER']);
    expect(start.env.HOME).toBe(home);
    expect(start.env.OPENCODE_PASSWORD).toBeUndefined();
  });

  posixIt('会話の serve が起きていれば --server でつなぎ、パスワードは環境だけで渡す', async () => {
    const serve = { url: 'http://127.0.0.1:1', password: 'pw-secret' };
    const { exporter, log } = make({ exports: { [SES]: exportOf(SES) } }, { serve });
    expect(await exporter.export(SES)).not.toBeNull();
    const start = log().find((e) => e.ev === 'start');
    if (start?.ev !== 'start') throw new Error('no start');
    expect(start.argv).toEqual(['session', 'export', '--server', serve.url, SES]);
    expect(start.argv.join(' ')).not.toContain(serve.password);
    expect(start.env.OPENCODE_PASSWORD).toBe(serve.password);
  });

  posixIt('serve につながらなければ --standalone で取り直す', async () => {
    const { exporter, log } = make({ exports: { [SES]: exportOf(SES) }, exportServerDown: true }, { serve: { url: 'http://127.0.0.1:1', password: 'pw' } });
    expect(await exporter.export(SES)).not.toBeNull();
    expect(log().filter((e) => e.ev === 'export').map((e) => (e.ev === 'export' ? e.via : ''))).toEqual(['server', 'standalone']);
  });

  posixIt('database is locked で落ちたら間をあけて取り直す', async () => {
    const { exporter, log } = make({ exports: { [SES]: exportOf(SES) }, exportLockTimes: 2 });
    expect(await exporter.export(SES)).not.toBeNull();
    expect(log().filter((e) => e.ev === 'export')).toHaveLength(3);
  });

  posixIt('書き出しに失敗したら前のファイルを残し、半端なファイルを置かない', async () => {
    const ok = make({ exports: { [SES]: exportOf(SES, 'first') } });
    const file = (await ok.exporter.export(SES))!;
    const before = fs.readFileSync(file, 'utf8');
    // 途中で落ちた（半端な JSON）。
    const cut = make({ exports: { [SES]: exportOf(SES, 'second') }, exportTruncate: true });
    expect(await cut.exporter.export(SES)).toBeNull();
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
    expect(leftovers()).toEqual([]);
    // 会話が見つからない。
    const gone = make({ exports: {} });
    expect(await gone.exporter.export(SES)).toBeNull();
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
    expect(leftovers()).toEqual([]);
  });

  posixIt('中身の会話の ID が頼んだ ID と違えば置かない', async () => {
    const { exporter } = make({ exports: { [SES]: exportOf('ses_other') } });
    expect(await exporter.export(SES)).toBeNull();
    expect(fs.existsSync(path.join(opencodeExportDir(home), `${SES}.json`))).toBe(false);
    expect(leftovers()).toEqual([]);
  });

  posixIt('鍵に使えない ID と、opencode が見つからないときは起こさない', async () => {
    const { exporter, log } = make({ exports: {} });
    expect(await exporter.export('../evil')).toBeNull();
    expect(await exporter.export('a/b')).toBeNull();
    expect(log()).toEqual([]);
    const none = make({ exports: { [SES]: exportOf(SES) } }, { bin: null });
    expect(await none.exporter.export(SES)).toBeNull();
  });

  posixIt('同じ会話を続けて頼まれても、書き出しは重ねない', async () => {
    const { exporter, log } = make({ exports: { [SES]: exportOf(SES) }, exportDelayMs: 200 });
    const [a, b] = await Promise.all([exporter.export(SES), exporter.export(SES)]);
    expect(a).not.toBeNull();
    expect(b).toBe(a);
    expect(log().filter((e) => e.ev === 'export')).toHaveLength(1);
  });
});
