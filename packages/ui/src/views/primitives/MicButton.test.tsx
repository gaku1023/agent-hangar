import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeVoicePort } from '../../voice/fakeVoicePort.ts';
import { MicButton } from './MicButton.tsx';

const mic = () => screen.getByRole('button', { name: '音声で入力' });

describe('MicButton', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(10_000); });
  afterEach(() => { vi.useRealTimers(); });

  it('listen が使えない環境ではボタンを出さない', () => {
    const port = new FakeVoicePort();
    port.canListenNow = false;
    render(<MicButton port={port} onSend={() => {}} />);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('押すと聞き始め、確定の文は 1.2 秒黙ると [voice] を付けて渡す', () => {
    const port = new FakeVoicePort();
    const onSend = vi.fn();
    render(<MicButton port={port} onSend={onSend} />);
    fireEvent.click(mic());
    expect(port.calls).toEqual(['listen:ja']);
    expect(mic()).toHaveAttribute('aria-pressed', 'true');
    act(() => port.handlers!.onFinal('進み具合を教えて'));
    act(() => { vi.advanceTimersByTime(1100); });
    expect(onSend).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(150); });
    expect(onSend).toHaveBeenCalledWith('[voice] 進み具合を教えて');
    expect(mic()).toHaveAttribute('aria-pressed', 'false');
  });

  it('話し続けている間は確定を延ばす', () => {
    const port = new FakeVoicePort();
    const onSend = vi.fn();
    render(<MicButton port={port} onSend={onSend} />);
    fireEvent.click(mic());
    act(() => port.handlers!.onInterim('あ'));
    act(() => { vi.advanceTimersByTime(1000); });
    act(() => port.handlers!.onFinal('あいう'));
    act(() => { vi.advanceTimersByTime(1000); });
    expect(onSend).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(300); });
    expect(onSend).toHaveBeenCalledWith('[voice] あいう');
  });

  it('途中の文を onInterim に流す', () => {
    const port = new FakeVoicePort();
    const onInterim = vi.fn();
    render(<MicButton port={port} onSend={() => {}} onInterim={onInterim} />);
    fireEvent.click(mic());
    act(() => port.handlers!.onInterim('えーと'));
    expect(onInterim).toHaveBeenLastCalledWith('えーと');
  });

  it('もう一度押すと、そこまでを送る', () => {
    const port = new FakeVoicePort();
    const onSend = vi.fn();
    render(<MicButton port={port} onSend={onSend} />);
    fireEvent.click(mic());
    act(() => port.handlers!.onInterim('途中まで'));
    fireEvent.click(mic());
    expect(onSend).toHaveBeenCalledWith('[voice] 途中まで');
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it('Esc は捨てる', () => {
    const port = new FakeVoicePort();
    const onSend = vi.fn();
    render(<MicButton port={port} onSend={onSend} />);
    fireEvent.click(mic());
    act(() => port.handlers!.onFinal('やめる'));
    fireEvent.keyDown(window, { key: 'Escape' });
    act(() => { vi.advanceTimersByTime(2000); });
    expect(port.calls).toContain('abort');
    expect(onSend).not.toHaveBeenCalled();
    expect(mic()).toHaveAttribute('aria-pressed', 'false');
  });

  it('読み上げ中に押すと cancel してから聞く', () => {
    const port = new FakeVoicePort();
    port.isSpeaking = true;
    render(<MicButton port={port} onSend={() => {}} />);
    fireEvent.click(mic());
    expect(port.calls).toEqual(['cancel', 'listen:ja']);
  });

  it('読み上げの間と直後 1.5 秒は、聞いた音を渡さない', () => {
    const port = new FakeVoicePort();
    const onSend = vi.fn();
    render(<MicButton port={port} onSend={onSend} />);
    fireEvent.click(mic());
    port.isSpeaking = true;
    act(() => port.handlers!.onFinal('自分の声'));
    port.finishSpeaking(Date.now());
    act(() => { vi.advanceTimersByTime(1000); port.handlers!.onFinal('余韻'); });
    act(() => { vi.advanceTimersByTime(2000); });
    expect(onSend).not.toHaveBeenCalled();
    act(() => port.handlers!.onFinal('本当の声'));
    act(() => { vi.advanceTimersByTime(1300); });
    expect(onSend).toHaveBeenCalledWith('[voice] 本当の声');
  });

  it('言語が英語なら en で聞き、aria-label も英語になる', async () => {
    const { LanguageRoot } = await import('./language.tsx');
    const port = new FakeVoicePort();
    render(<LanguageRoot language="en"><MicButton port={port} onSend={() => {}} /></LanguageRoot>);
    fireEvent.click(screen.getByRole('button', { name: 'Voice input' }));
    expect(port.calls).toEqual(['listen:en']);
  });

  it('認識が自分で終わったときは、たまった文を送る', () => {
    const port = new FakeVoicePort();
    const onSend = vi.fn();
    render(<MicButton port={port} onSend={onSend} />);
    fireEvent.click(mic());
    act(() => port.handlers!.onFinal('終わり'));
    act(() => port.handlers!.onEnd());
    expect(onSend).toHaveBeenCalledWith('[voice] 終わり');
  });
});
