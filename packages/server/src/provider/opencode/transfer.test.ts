import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect } from 'vitest';
import { readFakeOpencodeLog, writeFakeOpencode, type FakeOpencodeEvent, type FakeOpencodeOptions } from '../../../test/fake-opencode.ts';
import { posixDescribe, posixIt } from '../../../test/platform.ts';
import { ServeManager } from './serve/manager.ts';
import { ServeRegistry } from './serve/registry.ts';
import { OpencodeImportError, OpencodeTransfer } from './transfer.ts';

const SES = 'ses_e8e86939cffewIeT7kgc690PVE';
/** 実物の 2.1.4 の export の形（info と、古い順の messages）。 */
const exportOf = (directory: string, texts: string[] = ['first']) => ({
  info: { id: SES, title: 'exp', time: { created: 1, updated: 2 }, location: { directory } },
  messages: texts.map((text, i) => ({ id: `msg_${i}`, time: { created: 10 + i }, text, type: 'user' })),
});

const dirtyEnv: NodeJS.ProcessEnv = { ...process.env, CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'abc', HANGAR_TOKEN: 'secret' };

// 偽の opencode を本当に起こす。止め方が POSIX のものなので、Windows では飛ばす（段 G）。
posixDescribe('OpencodeTransfer', () => {
  let dir: string;
  let managers: ServeManager[];
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-oc-transfer-'));
    managers = [];
  });
  afterEach(async () => {
    for (const m of managers) await m.stopAll();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const make = (fake: FakeOpencodeOptions = {}) => {
    const { bin, logFile } = writeFakeOpencode(path.join(dir, 'oc'), fake);
    const serves = new ServeManager({
      enabled: () => true, bin: () => bin, version: async () => '2.1.4',
      registry: new ServeRegistry(path.join(dir, 'serves.json')), env: dirtyEnv, killGraceMs: 300, lockDelaysMs: [20],
    });
    managers.push(serves);
    const transfer = new OpencodeTransfer({ bin: () => bin, serves, env: dirtyEnv, lockDelaysMs: [10] });
    const log = (): FakeOpencodeEvent[] => readFakeOpencodeLog(logFile);
    return { transfer, serves, log };
  };
  const writeExport = (data: unknown): string => {
    const f = path.join(dir, 'remote.json');
    fs.writeFileSync(f, JSON.stringify(data));
    return f;
  };
  const here = (): string => {
    const d = path.join(dir, 'work', 'alpha');
    fs.mkdirSync(d, { recursive: true });
    return d;
  };

  posixIt('ほかの PC のパスの export を、この PC の場所（--directory）で取り込み、API の directory で確かめる', async () => {
    const { transfer, serves, log } = make();
    const local = here();
    const file = writeExport(exportOf('/Users/other/work/alpha'));
    await transfer.importSession({ hangarSessionId: 'h1', providerSessionId: SES, file, directory: local, replace: false });
    const imports = log().filter((e) => e.ev === 'import');
    expect(imports).toMatchObject([{ via: 'server', id: SES, directory: local, result: 'imported' }]);
    // 会話の serve につないで取り込む（私用のサーバを別に起こさない）。
    const start = log().find((e) => e.ev === 'start' && e.argv[0] === 'session');
    if (start?.ev !== 'start') throw new Error('no start');
    expect(start.argv).toEqual(['session', 'import', '--server', serves.get('h1')!.url, '--directory', local, file]);
    // パスワードは環境だけで渡し、hangar の印は渡さない。
    expect(start.env.OPENCODE_PASSWORD).toBe(serves.get('h1')!.password);
    expect(start.argv.join(' ')).not.toContain(serves.get('h1')!.password);
    expect(Object.keys(start.env).filter((k) => k.startsWith('CLAUDE') || k.startsWith('HANGAR_'))).toEqual([]);
    expect(log().filter((e) => e.ev === 'session')).toMatchObject([{ id: SES }]);
    // 取り込みの前に消さない（この PC に会話が無いとき）。
    expect(log().filter((e) => e.ev === 'delete')).toEqual([]);
  });

  posixIt('既にある ID は上書きされない（実物の 2.1.4 は Session already exists で 0 を返す）ので、replace なら消してから入れる', async () => {
    const local = here();
    const { transfer, log } = make({ exports: { [SES]: exportOf(local, ['first']) } });
    const file = writeExport(exportOf('/Users/other/work/alpha', ['first', 'second']));
    await transfer.importSession({ hangarSessionId: 'h1', providerSessionId: SES, file, directory: local, replace: true });
    const steps = log().filter((e) => e.ev === 'delete' || e.ev === 'import').map((e) => `${e.ev}:${'result' in e ? e.result : ''}`);
    expect(steps).toEqual(['delete:deleted', 'import:imported']);
  });

  posixIt('replace でなければ、既にある ID への取り込みを失敗として扱う（何も変わらないまま再開しない）', async () => {
    const local = here();
    const { transfer } = make({ exports: { [SES]: exportOf(local, ['first']) } });
    const file = writeExport(exportOf('/Users/other/work/alpha', ['first', 'second']));
    await expect(transfer.importSession({ hangarSessionId: 'h1', providerSessionId: SES, file, directory: local, replace: false }))
      .rejects.toMatchObject({ name: 'OpencodeImportError', reason: 'exists' });
  });

  posixIt('取り込んだ会話の場所が頼んだ場所と違えば、失敗にする', async () => {
    const { transfer } = make({ importIgnoresDirectory: true });
    const file = writeExport(exportOf('/Users/other/work/alpha'));
    const err = await transfer.importSession({ hangarSessionId: 'h1', providerSessionId: SES, file, directory: here(), replace: false }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OpencodeImportError);
    expect((err as OpencodeImportError).reason).toBe('directory');
  });

  posixIt('場所が無ければ（実物は LocationNotFoundError）失敗にする', async () => {
    const { transfer } = make();
    const file = writeExport(exportOf('/Users/other/work/alpha'));
    await expect(transfer.importSession({ hangarSessionId: 'h1', providerSessionId: SES, file, directory: path.join(dir, 'missing'), replace: false }))
      .rejects.toMatchObject({ reason: 'location' });
  });

  posixIt('quiesce は会話を interrupt し、/api/session/active から外れる（idle になる）まで待つ', async () => {
    const { transfer, serves, log } = make({ activeIds: [SES], activeUntilInterrupt: true });
    await serves.ensure('h1');
    expect(await transfer.quiesce('h1', SES, { timeoutMs: 3000, pollMs: 20 })).toBe('idle');
    expect(log().filter((e) => e.ev === 'interrupt')).toMatchObject([{ id: SES }]);
  });

  posixIt('quiesce は止まらなければ上限で諦める。serve が無ければ何もしない', async () => {
    const { transfer, serves, log } = make({ activeIds: [SES] });
    expect(await transfer.quiesce('h1', SES, { timeoutMs: 200, pollMs: 20 })).toBe('no-serve');
    expect(log().filter((e) => e.ev === 'start')).toEqual([]);
    await serves.ensure('h1');
    expect(await transfer.quiesce('h1', SES, { timeoutMs: 200, pollMs: 20 })).toBe('timeout');
  });
});
