import { describe, expect, it } from 'vitest';
import { EFFORT_VALUES, isEffort } from './launchChoices.ts';
import * as shared from './index.ts';

describe('effort の値表', () => {
  it('空（既定）から max まで 6 つ', () => {
    expect([...EFFORT_VALUES]).toEqual(['', 'low', 'medium', 'high', 'xhigh', 'max']);
    expect(shared.EFFORT_VALUES).toBe(EFFORT_VALUES);
  });

  it('isEffort は値表の文字列だけを通す', () => {
    for (const v of EFFORT_VALUES) expect(isEffort(v)).toBe(true);
    for (const v of ['Low', 'ultra', ' high', 'high ', null, undefined, 1, {}]) expect(isEffort(v)).toBe(false);
  });
});
