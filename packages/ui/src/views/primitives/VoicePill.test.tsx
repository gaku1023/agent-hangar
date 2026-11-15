import type { VoiceStateDto } from '@agent-hangar/shared';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VoicePill } from './VoicePill.tsx';

const st = (o: Partial<VoiceStateDto> = {}): VoiceStateDto => ({ available: true, models: { state: 'ready', progress: 1 }, mode: 'off', phase: 'off', caption: null, speakingId: null, meeting: false, callable: true, ...o });
const mkApi = () => ({ voiceHold: vi.fn(async () => ({})), voiceToggle: vi.fn(async () => ({})) });
const pill = () => screen.getByRole('button', { name: '音声で入力' });

describe('VoicePill', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('押し続けると hold が on になり、離すと off になる', () => {
    const api = mkApi();
    render(<VoicePill state={st()} api={api} />);
    fireEvent.pointerDown(pill());
    act(() => { vi.advanceTimersByTime(400); });
    expect(api.voiceHold).toHaveBeenCalledWith(true);
    fireEvent.pointerUp(pill());
    expect(api.voiceHold).toHaveBeenLastCalledWith(false);
    expect(api.voiceToggle).not.toHaveBeenCalled();
  });
  it('350 ms 未満で離すと toggle（切のとき on、入っているとき off）', () => {
    const api = mkApi();
    const { rerender } = render(<VoicePill state={st()} api={api} />);
    fireEvent.pointerDown(pill());
    act(() => { vi.advanceTimersByTime(100); });
    fireEvent.pointerUp(pill());
    expect(api.voiceToggle).toHaveBeenLastCalledWith(true);
    expect(api.voiceHold).not.toHaveBeenCalled();
    rerender(<VoicePill state={st({ mode: 'toggle', phase: 'listening' })} api={api} />);
    fireEvent.pointerDown(pill());
    fireEvent.pointerUp(pill());
    expect(api.voiceToggle).toHaveBeenLastCalledWith(false);
  });
  it('キーボードの Enter（click）も toggle になる', () => {
    const api = mkApi();
    render(<VoicePill state={st()} api={api} />);
    fireEvent.click(pill());
    expect(api.voiceToggle).toHaveBeenCalledWith(true);
  });
  it.each(['off', 'ambient', 'listening', 'window', 'meeting'] as const)('phase %s が data-phase に出る', (phase) => {
    render(<VoicePill state={st({ phase })} api={mkApi()} />);
    expect(pill()).toHaveAttribute('data-phase', phase);
  });
  it('字幕があるときだけ字幕の丸薬が伸びて出る', () => {
    const { rerender, container } = render(<VoicePill state={st({ phase: 'listening' })} api={mkApi()} />);
    expect(container.querySelector('.vp-pill')).toBeNull();
    rerender(<VoicePill state={st({ phase: 'listening', caption: 'ねえハンガー' })} api={mkApi()} />);
    expect(container.querySelector('.vp-pill')).toHaveTextContent('ねえハンガー');
    expect(container.querySelector('.vp-pill')).not.toHaveAttribute('data-sending');
    rerender(<VoicePill state={st({ phase: 'window', caption: 'ねえハンガー' })} api={mkApi()} />);
    expect(container.querySelector('.vp-pill')).toHaveAttribute('data-sending', 'true');
  });
  it('モデルを落としている間は縁を進みで満たし、文字は出さない', () => {
    render(<VoicePill state={st({ models: { state: 'downloading', progress: 0.4 } })} api={mkApi()} />);
    expect(pill().style.getPropertyValue('--vp-progress')).toBe('0.4');
    expect(pill()).toHaveAttribute('data-preparing', 'true');
    expect(pill()).toHaveTextContent('');
  });
});
