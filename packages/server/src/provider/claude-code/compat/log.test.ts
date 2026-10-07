import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { COMPAT_MAX_VALUE, CompatLog, compatPath } from './log.ts';

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-compat-')); });
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(tmp, { recursive: true, force: true }); });

describe('CompatLog', () => {
  it('同じ契約と値は 1 件にまとめ、回数、最初と最後の時刻、最後の版を持つ', () => {
    let t = 10;
    const log = new CompatLog({ file: null, localVersion: () => '2.1.292', now: () => t });
    log.note({ contract: 'registry', value: 'status=thinking', version: '2.1.300' });
    t = 20;
    log.note({ contract: 'registry', value: 'status=thinking', version: '2.1.301' });
    log.note({ contract: 'transcript', value: 'type=x', version: '2.1.301' });
    expect(log.count()).toBe(2);
    expect(log.list()).toEqual([
      { contract: 'registry', value: 'status=thinking', version: '2.1.301', count: 2, firstSeenAt: 10, lastSeenAt: 20 },
      { contract: 'transcript', value: 'type=x', version: '2.1.301', count: 1, firstSeenAt: 20, lastSeenAt: 20 },
    ]);
  });
  it('版の無いずれには手元の版を入れ、手元も分からなければ前の版を残す', () => {
    let local: string | null = '2.1.292';
    const log = new CompatLog({ file: null, localVersion: () => local, now: () => 1 });
    log.note({ contract: 'cli', value: 'help.commands=(missing)', version: null });
    expect(log.list()[0]!.version).toBe('2.1.292');
    local = null;
    log.note({ contract: 'cli', value: 'help.commands=(missing)', version: null });
    expect(log.list()[0]).toMatchObject({ version: '2.1.292', count: 2 });
    log.note({ contract: 'screen', value: 'prompt-marker=(missing)', version: null });
    expect(log.list().find((e) => e.contract === 'screen')!.version).toBeNull();
  });
  it('上限を超えたら、最後に見た時刻の古いものから落とす', () => {
    let t = 0;
    const log = new CompatLog({ file: null, localVersion: () => null, now: () => t, max: 3 });
    for (const v of ['a', 'b', 'c']) { t += 1; log.note({ contract: 'transcript', value: `type=${v}`, version: null }); }
    t += 1; log.note({ contract: 'transcript', value: 'type=a', version: null });
    t += 1; log.note({ contract: 'transcript', value: 'type=d', version: null });
    expect(log.list().map((e) => e.value).sort()).toEqual(['type=a', 'type=c', 'type=d']);
  });
  it('値は COMPAT_MAX_VALUE 文字で切り、切った値で 1 件にまとめる', () => {
    // 値は外のデータから来て、報告にも写される。長い値で記録が膨らまないようにする。
    expect(COMPAT_MAX_VALUE).toBe(200);
    const log = new CompatLog({ file: null, localVersion: () => null, now: () => 1 });
    const head = `type=${'x'.repeat(COMPAT_MAX_VALUE)}`;
    log.note({ contract: 'transcript', value: `${head}1`, version: null });
    log.note({ contract: 'transcript', value: `${head}2`, version: null });
    log.note({ contract: 'transcript', value: 'type=short', version: null });
    const list = log.list();
    expect(list.map((e) => e.value.length).sort((a, b) => a - b)).toEqual(['type=short'.length, COMPAT_MAX_VALUE]);
    expect(list.find((e) => e.value.length === COMPAT_MAX_VALUE)).toMatchObject({ value: head.slice(0, COMPAT_MAX_VALUE), count: 2 });
  });
  it('書き出して読み直すと同じ一覧になり、変わっていなければ書かない', () => {
    const file = compatPath(tmp);
    expect(file).toBe(path.join(tmp, 'compat.json'));
    const log = new CompatLog({ file, localVersion: () => '2.1.292', now: () => 5 });
    log.note({ contract: 'statusline', value: 'rate_limits.five_hour.resets_at=ms', version: '2.1.300' });
    log.flush();
    expect(fs.existsSync(file)).toBe(true);
    expect(new CompatLog({ file, localVersion: () => null }).list()).toEqual(log.list());
    // 一度書いたあとは dirty が落ちている。消したファイルを、変わっていない記録が書き直さないこと。
    fs.rmSync(file);
    log.flush();
    expect(fs.existsSync(file)).toBe(false);
    // 新しいずれが来れば、また書く。
    log.note({ contract: 'statusline', value: 'rate_limits.five_hour.resets_at=ms', version: '2.1.300' });
    log.flush();
    expect(fs.existsSync(file)).toBe(true);
  });
  it('壊れたファイルと形の違う項目は捨てて始め、投げない', () => {
    const file = compatPath(tmp);
    fs.writeFileSync(file, '{ broken');
    expect(new CompatLog({ file, localVersion: () => null }).count()).toBe(0);
    fs.writeFileSync(file, JSON.stringify({ version: 1, entries: [{ contract: 'nope', value: 'x' }, { contract: 'cli', value: 'subcommand.added=x', version: null, count: 1, firstSeenAt: 1, lastSeenAt: 1 }] }));
    expect(new CompatLog({ file, localVersion: () => null }).list().map((e) => e.value)).toEqual(['subcommand.added=x']);
  });
  it('手元の claude の版が変わったら記録を空にし、同じ版と読めない版では残す', () => {
    const file = compatPath(tmp);
    const log = new CompatLog({ file, localVersion: () => null, now: () => 1 });
    log.note({ contract: 'cli', value: 'subcommand.added=x', version: null });
    // 前の版が分からないうちは「変わった」と言えないので、持つだけで消さない。
    log.setLocalVersion('2.1.292');
    expect(log.count()).toBe(1);
    log.setLocalVersion('2.1.292');
    expect(log.count()).toBe(1);
    // 読めないときは消さない。
    log.setLocalVersion(null);
    expect(log.count()).toBe(1);
    log.flush();
    log.setLocalVersion('2.1.300');
    expect(log.count()).toBe(0);
    // 空にしたことも書き出す。
    log.flush();
    const saved = JSON.parse(fs.readFileSync(file, 'utf8')) as { localVersion: unknown; entries: unknown[] };
    expect(saved).toMatchObject({ localVersion: '2.1.300', entries: [] });
  });
  it('書き出して読み直すと手元の版も残り、次に違う版が来たら空にする', () => {
    const file = compatPath(tmp);
    const log = new CompatLog({ file, localVersion: () => null, now: () => 1 });
    log.setLocalVersion('2.1.292');
    log.note({ contract: 'cli', value: 'subcommand.added=x', version: null });
    log.flush();
    const again = new CompatLog({ file, localVersion: () => null });
    again.setLocalVersion('2.1.292');
    expect(again.count()).toBe(1);
    const third = new CompatLog({ file, localVersion: () => null });
    third.setLocalVersion('2.1.300');
    expect(third.count()).toBe(0);
  });
  it('手元の版の無い古い形のファイルも読め、その後の最初の版では消さない', () => {
    const file = compatPath(tmp);
    fs.writeFileSync(file, JSON.stringify({ version: 1, entries: [{ contract: 'cli', value: 'subcommand.added=x', version: '2.1.1', count: 1, firstSeenAt: 1, lastSeenAt: 1 }] }));
    const log = new CompatLog({ file, localVersion: () => null });
    expect(log.count()).toBe(1);
    log.setLocalVersion('2.1.300');
    expect(log.count()).toBe(1);
    // 持った版は、ずれが増えなくても書き出す。書かないと、次の起動でまた前の版が分からなくなる。
    log.flush();
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toMatchObject({ localVersion: '2.1.300' });
    log.setLocalVersion('2.1.301');
    expect(log.count()).toBe(0);
  });
  it('書けない置き場でも投げない', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    fs.writeFileSync(path.join(tmp, 'blocker'), 'x');
    const log = new CompatLog({ file: path.join(tmp, 'blocker', 'compat.json'), localVersion: () => null });
    log.note({ contract: 'cli', value: 'auth-status=(not-json)', version: null });
    expect(() => log.flush()).not.toThrow();
    // 書こうとして失敗した道を通ったこと（何もせず戻ったのではない）。
    expect(err).toHaveBeenCalledTimes(1);
    expect(() => log.stop()).not.toThrow();
    expect(err).toHaveBeenCalledTimes(2);
  });
});
