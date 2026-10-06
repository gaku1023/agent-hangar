import { describe, expect, it } from 'vitest';
import { arrangeSections, fitHeight, highlight, matches, place, roomFor, POPUP_FLOOR, type ListboxOption } from './listboxModel.ts';

const o = (value: string, sub?: string): ListboxOption => ({ value, label: value, sub });
const flat = (s: ReturnType<typeof arrangeSections>) => s.map((x) => [x.title, x.items.map((i) => `${i.index}:${i.option.value}`)]);

describe('matches', () => {
  it('名前か補足に、大文字小文字を区別せずに含まれれば残す', () => {
    expect(matches(o('Agent-Hangar', '~/w/agent-hangar'), 'hang')).toBe(true);
    expect(matches(o('alpha', '~/work/x'), 'WORK')).toBe(true);
    expect(matches(o('alpha', '~/w/x'), 'zzz')).toBe(false);
  });
  it('空白だけの問い合わせは全件に一致する', () => {
    expect(matches(o('alpha'), '  ')).toBe(true);
  });
});

describe('arrangeSections', () => {
  const opts = [o('a'), o('b'), o('c'), o('d')];
  it('群が無ければ見出しなしの 1 節で、通し番号を振る', () => {
    expect(flat(arrangeSections(opts, undefined, ''))).toEqual([[null, ['0:a', '1:b', '2:c', '3:d']]]);
  });
  it('群の順に並べ、通し番号は群をまたいで続く', () => {
    const groups = [{ title: '最近', values: ['c', 'a'] }, { title: 'すべて', values: ['b', 'd'] }];
    expect(flat(arrangeSections(opts, groups, ''))).toEqual([['最近', ['0:c', '1:a']], ['すべて', ['2:b', '3:d']]]);
  });
  it('空の群は出さず、群に入っていない項目は最後に見出しなしで置く', () => {
    const groups = [{ title: '最近', values: [] }, { title: 'すべて', values: ['b'] }];
    expect(flat(arrangeSections(opts, groups, ''))).toEqual([['すべて', ['0:b']], [null, ['1:a', '2:c', '3:d']]]);
  });
  it('検索で絞っている間は群を解き、一致した項目を元の並びで 1 列にする', () => {
    const groups = [{ title: '最近', values: ['c'] }, { title: 'すべて', values: ['a', 'b', 'd'] }];
    const withSub = [o('a', 'x'), o('b', 'hit'), o('c', 'hit'), o('d', 'x')];
    expect(flat(arrangeSections(withSub, groups, 'hit'))).toEqual([[null, ['0:b', '1:c']]]);
  });
  it('一致が無ければ空', () => {
    expect(arrangeSections(opts, undefined, 'zzz')).toEqual([]);
  });
});

describe('highlight', () => {
  it('最初に一致した部分だけを塗る', () => {
    expect(highlight('~/workspace/work', 'WORK')).toEqual([{ text: '~/', hit: false }, { text: 'work', hit: true }, { text: 'space/work', hit: false }]);
  });
  it('問い合わせが空か、一致しなければ 1 片のまま', () => {
    expect(highlight('alpha', '')).toEqual([{ text: 'alpha', hit: false }]);
    expect(highlight('alpha', 'z')).toEqual([{ text: 'alpha', hit: false }]);
  });
});

describe('place', () => {
  const viewport = { width: 1000, height: 800 };
  const face = { top: 100, bottom: 134, left: 200, width: 300 };
  it('下に収まれば、顔の直下に 6px 空けて置き、幅は顔に合わせる', () => {
    expect(place(face, 200, viewport)).toEqual({ left: 200, width: 300, top: 140, up: false });
  });
  it('幅は最小幅と顔の幅の大きいほう', () => {
    expect(place(face, 200, viewport, { minWidth: 420 }).width).toBe(420);
  });
  it('下に収まらず上のほうが広ければ上に開き、bottom で置く', () => {
    const low = { top: 700, bottom: 734, left: 200, width: 300 };
    expect(place(low, 300, viewport)).toEqual({ left: 200, width: 300, bottom: 106, up: true });
  });
  it('end に揃えると右端を顔の右端に合わせる', () => {
    expect(place({ top: 100, bottom: 128, left: 700, width: 90 }, 100, viewport, { minWidth: 220, align: 'end' }).left).toBe(570);
  });
  it('窓からはみ出さないよう、左右に 8px を残して寄せる', () => {
    expect(place({ top: 100, bottom: 128, left: 900, width: 90 }, 100, viewport, { minWidth: 300 }).left).toBe(692);
    expect(place({ top: 100, bottom: 128, left: 2, width: 90 }, 100, viewport, { minWidth: 300, align: 'end' }).left).toBe(8);
  });
});

describe('roomFor と fitHeight', () => {
  const viewport = { height: 600 };
  const face = { top: 260, bottom: 380 };
  it('下は窓の下端まで、上は窓の上端まで、顔との隙間（6px）と縁（8px）を引いた高さ', () => {
    expect(roomFor(face, viewport, false)).toBe(206);
    expect(roomFor(face, viewport, true)).toBe(246);
  });
  it('place が上下を決めるのと同じ数で測る', () => {
    const f = { top: 260, bottom: 380, left: 0, width: 100 };
    expect(place(f, 300, { width: 800, height: 600 }).up).toBe(true);
    expect(roomFor(f, viewport, true)).toBeGreaterThan(roomFor(f, viewport, false));
  });
  it('上限と使える高さの小さいほうにする。広ければ上限のまま', () => {
    expect(fitHeight(face, viewport, true, 300)).toBe(246);
    expect(fitHeight({ top: 100, bottom: 220 }, viewport, false, 300)).toBe(300);
  });
  it('使える高さがごくわずかでも、2 行は見える下限を割らない', () => {
    expect(fitHeight({ top: 20, bottom: 560 }, viewport, false, 300)).toBe(POPUP_FLOOR);
  });
});
