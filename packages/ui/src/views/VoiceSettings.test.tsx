import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { UiAction, VoiceCatalog, VoicePersona, VoiceSetting } from '@agent-hangar/shared';
import { ActionRoot } from '../action/chain.tsx';
import type { VoiceSettingsProps } from '../presenters/settings.ts';
import { VoiceSettings } from './VoiceSettings.tsx';

const persona = (over: Partial<VoicePersona> & { id: string }): VoicePersona => ({ name: 'ハンガー', reading: 'はんがー', tone: '', voice: 'kokoro:jf_alpha', voiceLabel: 'jf_alpha', speed: 1.2, ...over });
const P1 = persona({ id: 'p1' });
const P2 = persona({ id: 'p2', name: 'ずんだ', reading: 'ずんだ', tone: '語尾に「なのだ」を付ける。', voice: 'voicevox:1', voiceLabel: 'VOICEVOX:ずんだもん（あまあま）', speed: 1.1 });
const P3 = persona({ id: 'p3', name: 'セバス', reading: 'せばす', voice: 'os:com.apple.voice.Kyoko', voiceLabel: 'Kyoko', speed: 1 });

const CATALOG: VoiceCatalog = {
  sources: [
    { id: 'kokoro', running: true, speakers: ['jf_alpha', 'jf_gongitsune', 'jf_nezumi', 'jf_tebukuro', 'jm_kumo'].map((n) => ({ name: n, styles: [{ name: '', voice: `kokoro:${n}` }] })) },
    { id: 'voicevox', running: true, speakers: [
      { name: 'ずんだもん', styles: [{ name: 'ノーマル', voice: 'voicevox:3' }, { name: 'あまあま', voice: 'voicevox:1' }] },
      { name: '春日部つむぎ', styles: [{ name: 'ノーマル', voice: 'voicevox:8' }] },
    ] },
    { id: 'aivis', running: false, speakers: [] },
    { id: 'os', running: true, speakers: [{ name: 'Kyoko', styles: [{ name: '', voice: 'os:com.apple.voice.Kyoko' }] }, { name: 'Otoya', styles: [{ name: '', voice: 'os:com.apple.voice.Otoya' }] }] },
  ],
};

const setting = (personas: VoicePersona[] = [P1, P2, P3], over: Partial<VoiceSetting> = {}): VoiceSetting => ({ mode: 'off', personaId: personas[0]!.id, personas, ...over });
const props = (over: Partial<VoiceSettingsProps> = {}): VoiceSettingsProps => ({ voice: setting(), available: true, speakingId: null, catalog: CATALOG, ...over });
const ui = (p: VoiceSettingsProps, onAction: (a: UiAction) => void = () => {}) => render(<ActionRoot onAction={onAction}><VoiceSettings {...p} mark={undefined} /></ActionRoot>);
/** 保存の PATCH の voice を取り出す。 */
const patched = (fn: ReturnType<typeof vi.fn>): VoiceSetting => {
  const c = fn.mock.calls.map((x) => x[0] as UiAction).filter((a) => a.type === 'settings.update');
  expect(c.length).toBeGreaterThan(0);
  const a = c[c.length - 1] as Extract<UiAction, { type: 'settings.update' }>;
  expect(a.field).toBe('voice');
  return a.patch.voice as VoiceSetting;
};
const open = (name: string) => fireEvent.click(screen.getByRole('button', { name: new RegExp(`^${name}`) }));

afterEach(() => { vi.useRealTimers(); });

describe('統括の声の設定（試作 C と X）', () => {
  it('聞き方の 3 つを切り替えると、voice の全体を mode だけ替えて保存し、常に聞くのときだけ「ねえ、<読み>」が出る', () => {
    const onAction = vi.fn();
    const { rerender } = ui(props(), onAction);
    const g = screen.getByRole('radiogroup', { name: '聞き方' });
    expect(within(g).getAllByRole('radio').map((r) => r.textContent)).toEqual(['押している間だけ', '押して切り替え', '常に聞く']);
    expect(screen.getByTestId('voice-wake')).toHaveAttribute('data-on', 'false');
    fireEvent.click(within(g).getByRole('radio', { name: '常に聞く' }));
    expect(patched(onAction)).toEqual({ ...setting(), mode: 'always' });
    rerender(<ActionRoot onAction={onAction}><VoiceSettings {...props({ voice: setting([P1, P2, P3], { mode: 'always' }) })} mark={undefined} /></ActionRoot>);
    expect(screen.getByTestId('voice-wake')).toHaveAttribute('data-on', 'true');
    expect(screen.getByTestId('voice-wake')).toHaveTextContent('「ねえ、はんがー」');
  });

  it('読みが空の人格では、常に聞くでも呼びかけは出さない', () => {
    ui(props({ voice: setting([persona({ id: 'p1', reading: '' })], { mode: 'always' }) }));
    expect(screen.getByTestId('voice-wake')).toHaveAttribute('data-on', 'false');
  });

  it('人格の行の下に、声の一言と速さを出す（VOICEVOX は声のクレジットの形、Kokoro は Kokoro を頭に、Mac の声は名前）', () => {
    ui(props());
    expect(screen.getByRole('button', { name: /^ハンガー/ })).toHaveTextContent('Kokoro jf_alpha · 1.2');
    expect(screen.getByRole('button', { name: /^ずんだ/ })).toHaveTextContent('VOICEVOX:ずんだもん（あまあま） · 1.1');
    expect(screen.getByRole('button', { name: /^セバス/ })).toHaveTextContent('Kyoko · 1.0');
  });

  it('丸を押すと、その人格を使うように personaId を保存する。使っている丸だけが選ばれている', () => {
    const onAction = vi.fn();
    ui(props(), onAction);
    const radios = ['ハンガー', 'ずんだ', 'セバス'].map((n) => screen.getByRole('radio', { name: n }));
    expect(radios.map((r) => r.getAttribute('aria-checked'))).toEqual(['true', 'false', 'false']);
    fireEvent.click(screen.getByRole('radio', { name: 'ずんだ' }));
    expect(patched(onAction)).toEqual({ ...setting(), personaId: 'p2' });
  });

  it('行を押すと、その人格を選んで開く。開くのは 1 つだけで、別の行を押すとそちらへ移る', () => {
    const onAction = vi.fn();
    ui(props(), onAction);
    expect(screen.queryByLabelText('名前')).toBeNull();
    open('ずんだ');
    expect(patched(onAction).personaId).toBe('p2');
    expect(screen.getByRole('button', { name: /^ずんだ/ })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByLabelText('名前')).toHaveValue('ずんだ');
    expect(screen.getByLabelText('口調')).toHaveValue('語尾に「なのだ」を付ける。');
    expect(screen.getByLabelText('口調')).toHaveAttribute('placeholder', '自由に書く');
    open('セバス');
    expect(screen.getAllByLabelText('名前')).toHaveLength(1);
    expect(screen.getByLabelText('名前')).toHaveValue('セバス');
    expect(screen.getByRole('button', { name: /^ずんだ/ })).toHaveAttribute('aria-expanded', 'false');
  });

  it('足すと、新しい人格を末尾に入れて使うようにして保存する。人格は 8 人まで', () => {
    const onAction = vi.fn();
    const { rerender } = ui(props(), onAction);
    fireEvent.click(screen.getByRole('button', { name: '+ 足す' }));
    const v = patched(onAction);
    expect(v.personas).toHaveLength(4);
    expect(v.personas.slice(0, 3)).toEqual([P1, P2, P3]);
    const added = v.personas[3]!;
    expect(added).toMatchObject({ name: '新しい人格', reading: 'あたらしい', tone: '', voice: 'kokoro:jf_alpha', voiceLabel: 'jf_alpha', speed: 1.2 });
    expect(new Set(v.personas.map((p) => p.id)).size).toBe(4);
    expect(v.personaId).toBe(added.id);
    const eight = Array.from({ length: 8 }, (_, i) => persona({ id: `q${i}`, name: `人${i}` }));
    rerender(<ActionRoot onAction={onAction}><VoiceSettings {...props({ voice: setting(eight) })} mark={undefined} /></ActionRoot>);
    expect(screen.getByRole('button', { name: '+ 足す' })).toBeDisabled();
  });

  it('消すと、その人格を外して保存する。使っている人格を消すと、前の人格が選ばれる', async () => {
    const onAction = vi.fn();
    ui(props({ voice: setting([P1, P2, P3], { personaId: 'p2' }) }), onAction);
    open('ずんだ');
    fireEvent.click(screen.getByRole('button', { name: '消す' }));
    await waitFor(() => expect(onAction).toHaveBeenCalled());
    expect(patched(onAction)).toEqual({ mode: 'off', personaId: 'p1', personas: [P1, P3] });
  });

  it('使っていない人格を消しても、使っている人格は変わらない。先頭を消して使っていたなら、次が選ばれる', async () => {
    const onAction = vi.fn();
    const first = ui(props({ voice: setting([P1, P2, P3], { personaId: 'p3' }) }), onAction);
    open('ずんだ');
    fireEvent.click(screen.getByRole('button', { name: '消す' }));
    await waitFor(() => expect(onAction).toHaveBeenCalled());
    expect(patched(onAction).personaId).toBe('p3');
    first.unmount();
    const second = vi.fn();
    ui(props({ voice: setting([P1, P2], { personaId: 'p1' }) }), second);
    open('ハンガー');
    fireEvent.click(screen.getByRole('button', { name: '消す' }));
    await waitFor(() => expect(second).toHaveBeenCalled());
    expect(patched(second).personaId).toBe('p2');
  });

  it('最後の 1 人は消せない', () => {
    const onAction = vi.fn();
    ui(props({ voice: setting([P1]) }), onAction);
    open('ハンガー');
    const del = screen.getByRole('button', { name: '消す' });
    expect(del).toBeDisabled();
    fireEvent.click(del);
    expect(onAction.mock.calls.filter((c) => (c[0] as UiAction).type === 'settings.update')).toHaveLength(0);
  });

  it('出どころの切り替え：動いている出どころを選ぶと、その先頭の声に替えて、声の一言も書く', () => {
    const onAction = vi.fn();
    ui(props(), onAction);
    open('ハンガー');
    const src = screen.getByRole('radiogroup', { name: '声の出どころ' });
    expect(within(src).getAllByRole('radio').map((r) => r.textContent)).toEqual(['Kokoro', 'VOICEVOX', 'AivisSpeech', 'この Mac']);
    expect(within(src).getByRole('radio', { name: 'Kokoro' })).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(within(src).getByRole('radio', { name: 'VOICEVOX' }));
    const v = patched(onAction);
    expect(v.personas[0]).toEqual({ ...P1, voice: 'voicevox:3', voiceLabel: 'VOICEVOX:ずんだもん' });
  });

  it('話者とスタイルを選ぶ。スタイルはノーマルなら括弧なし、2 つ以上あるときだけ選択が出る', () => {
    const onAction = vi.fn();
    ui(props(), onAction);
    open('ずんだ');
    expect(screen.getByLabelText('話者')).toHaveValue('ずんだもん');
    expect(screen.getByLabelText('スタイル')).toHaveValue('voicevox:1');
    fireEvent.change(screen.getByLabelText('スタイル'), { target: { value: 'voicevox:3' } });
    expect(patched(onAction).personas[1]).toEqual({ ...P2, voice: 'voicevox:3', voiceLabel: 'VOICEVOX:ずんだもん' });
    fireEvent.change(screen.getByLabelText('話者'), { target: { value: '春日部つむぎ' } });
    expect(patched(onAction).personas[1]).toMatchObject({ voice: 'voicevox:8', voiceLabel: 'VOICEVOX:春日部つむぎ' });
  });

  it('スタイルが 1 つの話者（Kokoro）では、スタイルの選択を出さない', () => {
    ui(props());
    open('ハンガー');
    expect(screen.getByLabelText('話者')).toHaveValue('jf_alpha');
    expect(screen.queryByLabelText('スタイル')).toBeNull();
  });

  it('止まっている出どころは薄く、押せる。押すと話者の欄の代わりに「<アプリ名> を開く」を出し、保存はしない', () => {
    const onAction = vi.fn();
    ui(props(), onAction);
    open('ハンガー');
    const src = screen.getByRole('radiogroup', { name: '声の出どころ' });
    const aivis = within(src).getByRole('radio', { name: 'AivisSpeech' });
    expect(aivis).toHaveAttribute('data-dim', 'true');
    expect(within(src).getByRole('radio', { name: 'VOICEVOX' })).not.toHaveAttribute('data-dim');
    fireEvent.click(aivis);
    expect(screen.queryByLabelText('話者')).toBeNull();
    expect(onAction.mock.calls.filter((c) => (c[0] as UiAction).type === 'settings.update')).toHaveLength(0);
    onAction.mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'AivisSpeech を開く' }));
    expect(onAction).toHaveBeenCalledWith({ type: 'voice.engine', source: 'aivis' });
  });

  it('エンジンを開いたあと 1 秒おきに声の一覧を読み直し、動き出したら話者の欄に戻して先頭の声に替える', () => {
    vi.useFakeTimers();
    const onAction = vi.fn();
    const { rerender } = ui(props(), onAction);
    open('ハンガー');
    fireEvent.click(within(screen.getByRole('radiogroup', { name: '声の出どころ' })).getByRole('radio', { name: 'AivisSpeech' }));
    fireEvent.click(screen.getByRole('button', { name: 'AivisSpeech を開く' }));
    onAction.mockClear();
    act(() => { vi.advanceTimersByTime(1000); });
    expect(onAction).toHaveBeenCalledWith({ type: 'voice.catalog.load' });
    const running: VoiceCatalog = { sources: CATALOG.sources.map((s) => (s.id === 'aivis' ? { id: 'aivis', running: true, speakers: [{ name: 'Anneli', styles: [{ name: 'ノーマル', voice: 'aivis:888753760' }] }] } : s)) };
    rerender(<ActionRoot onAction={onAction}><VoiceSettings {...props({ catalog: running })} mark={undefined} /></ActionRoot>);
    expect(screen.queryByRole('button', { name: 'AivisSpeech を開く' })).toBeNull();
    expect(patched(onAction).personas[0]).toMatchObject({ voice: 'aivis:888753760', voiceLabel: 'AivisSpeech:Anneli' });
    onAction.mockClear();
    act(() => { vi.advanceTimersByTime(5000); });
    expect(onAction).not.toHaveBeenCalled();
  });

  it('補助が使えない環境では、声の欄（出どころと話者）と試し聞きを出さず、聞き方と名前・読み・口調・速さだけにする', () => {
    const onAction = vi.fn();
    ui(props({ available: false, catalog: null }), onAction);
    expect(screen.getByRole('radiogroup', { name: '聞き方' })).toBeInTheDocument();
    open('ずんだ');
    expect(screen.getByLabelText('名前')).toBeInTheDocument();
    expect(screen.getByLabelText('読み')).toBeInTheDocument();
    expect(screen.getByLabelText('口調')).toBeInTheDocument();
    expect(screen.getByLabelText('速さ')).toBeInTheDocument();
    expect(screen.queryByRole('radiogroup', { name: '声の出どころ' })).toBeNull();
    expect(screen.queryByLabelText('話者')).toBeNull();
    expect(screen.queryByRole('button', { name: '試し聞き' })).toBeNull();
    expect(onAction.mock.calls.filter((c) => (c[0] as UiAction).type === 'voice.catalog.load')).toHaveLength(0);
  });

  it('補助があるときは、開いたときに声の一覧を読み込む', () => {
    const onAction = vi.fn();
    ui(props({ catalog: null }), onAction);
    expect(onAction).toHaveBeenCalledWith({ type: 'voice.catalog.load' });
  });

  it('試し聞きは、その人格の声と速さで鳴らす。鳴っている間（preview- の話）は動く棒を出す', () => {
    const onAction = vi.fn();
    const { rerender } = ui(props(), onAction);
    open('ずんだ');
    const btn = screen.getByRole('button', { name: '試し聞き' });
    expect(btn).not.toHaveAttribute('data-playing');
    fireEvent.click(btn);
    expect(onAction).toHaveBeenCalledWith({ type: 'voice.preview', voice: 'voicevox:1', speed: 1.1 });
    rerender(<ActionRoot onAction={onAction}><VoiceSettings {...props({ speakingId: 'preview-3' })} mark={undefined} /></ActionRoot>);
    expect(screen.getByRole('button', { name: '試し聞き' })).toHaveAttribute('data-playing', 'true');
    rerender(<ActionRoot onAction={onAction}><VoiceSettings {...props({ speakingId: 'orch-1' })} mark={undefined} /></ActionRoot>);
    expect(screen.getByRole('button', { name: '試し聞き' })).not.toHaveAttribute('data-playing');
  });

  it('名前は欄を出たら保存し、前後の空白は落とす。決まりに合わない読み（ひらがな 2〜20 字か空）は保存しない', () => {
    const onAction = vi.fn();
    ui(props(), onAction);
    open('ハンガー');
    onAction.mockClear();
    fireEvent.change(screen.getByLabelText('名前'), { target: { value: ' ハンガー二号 ' } });
    fireEvent.blur(screen.getByLabelText('名前'));
    expect(patched(onAction).personas[0]).toEqual({ ...P1, name: 'ハンガー二号' });
    onAction.mockClear();
    fireEvent.change(screen.getByLabelText('読み'), { target: { value: 'Hangar' } });
    fireEvent.blur(screen.getByLabelText('読み'));
    expect(onAction.mock.calls.filter((c) => (c[0] as UiAction).type === 'settings.update')).toHaveLength(0);
    fireEvent.change(screen.getByLabelText('読み'), { target: { value: '' } });
    fireEvent.blur(screen.getByLabelText('読み'));
    expect(patched(onAction).personas[0]).toMatchObject({ reading: '' });
  });

  it('打っている間は 600ms の間を置いてから保存する（打ち続けても 1 回）', () => {
    vi.useFakeTimers();
    const onAction = vi.fn();
    ui(props(), onAction);
    open('ハンガー');
    onAction.mockClear();
    fireEvent.change(screen.getByLabelText('口調'), { target: { value: '短く話す。' } });
    act(() => { vi.advanceTimersByTime(300); });
    fireEvent.change(screen.getByLabelText('口調'), { target: { value: '短く話す。丁寧に。' } });
    act(() => { vi.advanceTimersByTime(500); });
    expect(onAction).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(200); });
    expect(onAction.mock.calls.filter((c) => (c[0] as UiAction).type === 'settings.update')).toHaveLength(1);
    expect(patched(onAction).personas[0]).toMatchObject({ tone: '短く話す。丁寧に。' });
  });

  it('速さは 0.5〜2 の範囲で動かし、voice の全体で保存する', () => {
    vi.useFakeTimers();
    const onAction = vi.fn();
    ui(props(), onAction);
    open('ハンガー');
    const slider = screen.getByLabelText('速さ');
    expect(slider).toHaveAttribute('min', '0.5');
    expect(slider).toHaveAttribute('max', '2');
    fireEvent.change(slider, { target: { value: '1.5' } });
    act(() => { vi.advanceTimersByTime(600); });
    expect(patched(onAction)).toEqual({ ...setting(), personas: [{ ...P1, speed: 1.5 }, P2, P3] });
  });

  it('声が一覧から消えていても（話者の入れ替え）、保存した一言を行に出し、選択には残った値を出す', () => {
    ui(props({ voice: setting([persona({ id: 'p1', voice: 'voicevox:999', voiceLabel: 'VOICEVOX:消えた人' })]) }));
    expect(screen.getByRole('button', { name: /^ハンガー/ })).toHaveTextContent('VOICEVOX:消えた人 · 1.2');
    open('ハンガー');
    expect(screen.getByLabelText('話者')).toHaveDisplayValue('VOICEVOX:消えた人');
  });

  it('保存の失敗は、欄の下に理由を出す', () => {
    render(<ActionRoot onAction={() => {}}><VoiceSettings {...props()} mark={{ kind: 'error', message: '保存できませんでした' }} /></ActionRoot>);
    expect(screen.getByRole('alert')).toHaveTextContent('保存できませんでした');
  });
});
