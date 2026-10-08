import { spawn } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isAlive, parseStartTime, probeStartTime, sameStartTime, spawnRun, startTimeOf, terminate, type ProcRun } from './proc.ts';

describe('parseStartTime', () => {
  it('ps の lstart を UTC として読む', () => {
    expect(parseStartTime('Thu Oct  2 02:30:05 2026')).toBe(Date.UTC(2026, 9, 2, 2, 30, 5));
  });
  // Windows の Claude Code は、1601 年からの 100 ナノ秒単位の整数を文字列で書く（2026-10-05 実測）。
  it('Windows の 100 ナノ秒単位の整数を読む', () => {
    // 2026-10-02T08:40:35.0009738Z
    expect(parseStartTime('134354040350009738')).toBe(Date.UTC(2026, 9, 2, 8, 40, 35, 0));
  });
  it('読めないものは null', () => {
    expect(parseStartTime('')).toBeNull();
    expect(parseStartTime('12345')).toBeNull();
    expect(parseStartTime('Thu Feb 30 02:30:05 2026')).toBeNull();
  });
});

describe('sameStartTime', () => {
  it('空白の並びの違いを吸い、数値は文字列として比べる', () => {
    expect(sameStartTime('Thu Oct  2 02:30:05 2026', 'Thu Oct 2 02:30:05 2026')).toBe(true);
    expect(sameStartTime('134354040350009738', ' 134354040350009738\r\n')).toBe(true);
    expect(sameStartTime('134354040350009738', '134354040350009739')).toBe(false);
  });
});

describe('startTimeOf（偽の実行）', () => {
  // 読めなかった経過の警告は、ここでは黙らせる。出し方は「聞き直し」の節で確かめる。
  beforeEach(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}); });
  afterEach(() => { vi.restoreAllMocks(); });
  it('Windows は PowerShell に聞き、数字だけの答えを返す', () => {
    const calls: { file: string; args: string[] }[] = [];
    const run: ProcRun = (file, args) => { calls.push({ file, args }); return { status: 0, stdout: '134354040350009738\r\n' }; };
    expect(startTimeOf(6196, 'win32', run)).toBe('134354040350009738');
    expect(calls[0]!.file).toBe('powershell.exe');
    expect(calls[0]!.args.join(' ')).toContain('Get-Process -Id 6196');
  });
  // 聞く前に相手が消えたとき。PowerShell は失敗で終わる。
  it('相手が居なければ null', () => {
    expect(startTimeOf(6196, 'win32', () => ({ status: 1, stdout: '' }))).toBeNull();
    expect(startTimeOf(6196, 'win32', () => ({ status: 0, stdout: 'Get-Process : ...' }))).toBeNull();
    expect(startTimeOf(6196, 'darwin', () => ({ status: 1, stdout: '' }))).toBeNull();
  });
  it('整数でない pid は、何も起こさずに null', () => {
    let called = false;
    const run: ProcRun = () => { called = true; return { status: 0, stdout: '1' }; };
    expect(startTimeOf(1.5, 'win32', run)).toBeNull();
    expect(startTimeOf(-1, 'darwin', run)).toBeNull();
    expect(startTimeOf(Number.NaN, 'win32', run)).toBeNull();
    expect(called).toBe(false);
  });
});

// 2026-10-07 と 08 に、CI の Windows で PowerShell が 10 秒の締め切りを越えて止められ、生きている子の起動時刻が null で返った。
describe('startTimeOf の聞き直し（偽の実行）', () => {
  const WIN = '134354040350009738';
  const killed = { status: null, stdout: '', stderr: '', timedOut: true };
  /** 答えを順に返す偽の実行。答えが尽きたら読めた答えを返し、何回聞かれたかを残す。 */
  const answers = (...rs: ReturnType<ProcRun>[]) => {
    const calls: { file: string; args: string[] }[] = [];
    const run: ProcRun = (file, args) => { calls.push({ file, args }); return rs[calls.length - 1] ?? { status: 0, stdout: WIN }; };
    return { run, calls };
  };
  beforeEach(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('締め切りで止められたら、同じ問いでもう 1 度だけ読む', () => {
    const { run, calls } = answers(killed, { status: 0, stdout: `${WIN}\r\n` });
    expect(startTimeOf(6196, 'win32', run)).toBe(WIN);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual(calls[0]);
  });
  it('macOS と Linux の ps でも同じ', () => {
    const { run, calls } = answers(killed, { status: 0, stdout: 'Thu Oct  2 02:30:05 2026\n' });
    expect(startTimeOf(6196, 'darwin', run)).toBe('Thu Oct  2 02:30:05 2026');
    expect(calls).toHaveLength(2);
  });
  it('2 回とも止められたら null。3 回目は聞かない', () => {
    const { run, calls } = answers(killed, killed);
    expect(startTimeOf(6196, 'win32', run)).toBeNull();
    expect(calls).toHaveLength(2);
  });
  // 居ない、読めない答えが返った、起こせなかった、はどれも聞き直しても変わらない。止めた後の確かめが 2 倍かかるだけになる。
  it('一度目が締め切り以外で失敗したら、二度目なら読めるとしても聞き直さずに null', () => {
    for (const first of [{ status: 1, stdout: '' }, { status: 0, stdout: 'Get-Process : ...' }, { status: null, stdout: '', timedOut: false }]) {
      const { run, calls } = answers(first);
      expect(startTimeOf(6196, 'win32', run), JSON.stringify(first)).toBeNull();
      expect(calls).toHaveLength(1);
    }
  });
  it('各回の終了コード、締め切りで止められたか、出力、かかった時間を経過に残す', () => {
    const { run } = answers(killed, { status: 1, stdout: '', stderr: 'boom\r\n' });
    const p = probeStartTime(6196, 'win32', run);
    expect(p.value).toBeNull();
    expect(p.tries).toEqual([
      { status: null, timedOut: true, stdout: '', stderr: '', ms: expect.any(Number) },
      { status: 1, timedOut: false, stdout: '', stderr: 'boom', ms: expect.any(Number) },
    ]);
  });
  it('止められた回があれば、読めても読めなくても経過を警告に出す。居ないと静かに答えただけ、1 回で読めただけなら出さない', () => {
    const warn = vi.mocked(console.warn);
    startTimeOf(6196, 'win32', answers(killed).run);
    startTimeOf(6196, 'win32', answers(killed, killed).run);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls.map((c) => c.join(' ')).join('\n')).toContain('"timedOut":true');
    warn.mockClear();
    startTimeOf(6196, 'win32', answers({ status: 1, stdout: '' }).run);
    startTimeOf(6196, 'darwin', answers({ status: 1, stdout: '' }).run);
    startTimeOf(6196, 'win32', answers().run);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('spawnRun（実物の実行）', () => {
  it('締め切りで止めたことを timedOut で知らせる', () => {
    const r = spawnRun(300)(process.execPath, ['-e', 'setTimeout(() => {}, 10000)']);
    expect(r.status).toBeNull();
    expect(r.timedOut).toBe(true);
  });
  it('終われば終了コードと出力を返し、timedOut は false', () => {
    const r = spawnRun(10_000)(process.execPath, ['-e', 'process.stdout.write("out"); process.stderr.write("err"); process.exitCode = 3']);
    expect(r).toEqual({ status: 3, stdout: 'out', stderr: 'err', timedOut: false });
  });
  it('起こせなければ status は null だが、締め切りではない', () => {
    const r = spawnRun(10_000)('hangar-no-such-command', []);
    expect(r.status).toBeNull();
    expect(r.timedOut).toBe(false);
  });
});

describe('実物のプロセス', () => {
  // 聞き直しまで含めると、起動時刻の 1 回の読み取りは最悪 20 秒かかる。その後に止めて、もう 2 回読むので、既定の 20 秒では足りない。
  it('起動時刻を読み、止めて終わるまで待つ', async () => {
    // 起動時刻は秒に切り下げて返るので、起こす前の時刻も秒に切り下げて比べる。
    const before = Math.floor(Date.now() / 1000) * 1000;
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
    const pid = child.pid!;
    const exited = new Promise((r) => child.once('exit', r));
    try {
      // 読めなかったときは、各回の終了コード、締め切りで止められたか、出力、かかった時間を失敗の文に載せる。
      const probe = probeStartTime(pid);
      expect(probe.value, JSON.stringify(probe.tries)).not.toBeNull();
      const started = probe.value;
      // 起こす前から読み終わるまでの間に収まる。読み取りにかかった時間に左右されないよう、今の時刻との差では比べない。
      // ps の lstart は起動からの経過で求めるので、壁時計と数秒ずれることがある。その分の幅を持たせる。
      const at = parseStartTime(started!)!;
      expect(at).toBeGreaterThanOrEqual(before - 5000);
      expect(at).toBeLessThanOrEqual(Date.now() + 5000);
      // 2 回聞いても同じ値。PID の使い回しを見分ける鍵になる。
      expect(sameStartTime(started!, startTimeOf(pid)!)).toBe(true);
      expect(isAlive(pid)).toBe(true);
      const done = terminate(pid, 5000);
      await exited;
      expect(await done).toBe(true);
      expect(isAlive(pid)).toBe(false);
      expect(startTimeOf(pid)).toBeNull();
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill();
    }
  }, 40_000);
});
