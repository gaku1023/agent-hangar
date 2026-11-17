import { describe, expect, it } from 'vitest';
import { acceptsInput, isTurnRunning, isTurnWorking, turnPhaseOf } from './liveFilter.ts';

describe('turnPhaseOf', () => {
  it('登録の status と aside から段階を決める', () => {
    expect(turnPhaseOf({ status: 'busy' })).toBe('running');
    expect(turnPhaseOf({ status: 'busy', aside: { shell: false, agents: 1 } })).toBe('aside');
    expect(turnPhaseOf({ status: 'busy', aside: null })).toBe('running');
    expect(turnPhaseOf({ status: 'waiting', aside: { shell: true, agents: 0 } })).toBe('waiting');
    expect(turnPhaseOf({ status: 'idle' })).toBe('idle');
    expect(turnPhaseOf({ status: null })).toBe('none');
    expect(turnPhaseOf({ status: undefined })).toBe('none');
  });
  it('述語は段階の読み方をそろえる', () => {
    expect(isTurnWorking('aside')).toBe(true);
    expect(isTurnRunning('aside')).toBe(false);
    expect(acceptsInput('aside')).toBe(true);
    expect(acceptsInput('running')).toBe(false);
  });
});
