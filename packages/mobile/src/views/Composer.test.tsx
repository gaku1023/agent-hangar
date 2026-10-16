import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AskError, type Asker, type CommandHit, type FileHit } from '../ask.ts';
import type { Attachment, Attachments } from '../images.ts';
import { Composer, findTrigger, insertAt } from './Composer.tsx';

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

const COMMANDS: CommandHit[] = [
  { name: 'review', description: '差分をレビューする', kind: 'skill' },
  { name: 'release-notes', description: 'リリースノートを下書きする', kind: 'skill' },
  { name: 'compact', description: '会話を要約する', kind: 'command' },
];
const FILES: FileHit[] = [
  { path: 'src/app.ts', changed: true },
  { path: 'README.md', changed: false },
];

function noAttachments(over: Partial<Attachments> = {}): Attachments {
  return { items: [], add: vi.fn(async () => undefined), remove: vi.fn(), retry: vi.fn(), notice: null, busy: false, failed: false, ready: [], ...over };
}

type Opts = { pc?: string | null; projectId?: string | null; accountId?: string | null; asker?: Partial<Asker>; attachments?: Attachments; initial?: string };

function setup(o: Opts = {}) {
  const asker: Asker = {
    commands: vi.fn(async () => COMMANDS),
    files: vi.fn(async () => FILES),
    ...o.asker,
  };
  const attachments = o.attachments ?? noAttachments();
  function Harness() {
    const [v, setV] = useState(o.initial ?? '');
    return (
      <>
        <label htmlFor="cmp">初期プロンプト</label>
        <Composer
          id="cmp"
          value={v}
          onChange={setV}
          asker={asker}
          pc={o.pc === undefined ? 'pc-1' : o.pc}
          pcName="Mac"
          projectId={o.projectId === undefined ? 'p-a' : o.projectId}
          projectName="project-a"
          accountId={o.accountId === undefined ? 'acc-1' : o.accountId}
          accountName="アカウント 1"
          attachments={attachments}
        />
      </>
    );
  }
  render(<Harness />);
  const ta = screen.getByRole('textbox', { name: '初期プロンプト' }) as HTMLTextAreaElement;
  act(() => ta.focus());
  const type = (text: string) => fireEvent.change(ta, { target: { value: text, selectionStart: text.length, selectionEnd: text.length } });
  return { asker, attachments, ta, type };
}

const sheet = () => screen.queryByRole('region', { name: '候補' });

describe('findTrigger と insertAt', () => {
  it('行頭か空白の直後の / と @ だけを拾う', () => {
    expect(findTrigger('/', 1)).toEqual({ kind: '/', q: '', start: 0, caret: 1 });
    expect(findTrigger('直して /re', 7)).toEqual({ kind: '/', q: 're', start: 4, caret: 7 });
    expect(findTrigger('a\n@sr', 5)).toEqual({ kind: '@', q: 'sr', start: 2, caret: 5 });
    expect(findTrigger('a/b', 3)).toBeNull();
    expect(findTrigger('mail@x', 6)).toBeNull();
    expect(findTrigger('/a/b', 4)).toBeNull();
    expect(findTrigger('@src/app', 8)).toEqual({ kind: '@', q: 'src/app', start: 0, caret: 8 });
    expect(findTrigger('/review ', 8)).toBeNull();
  });

  it('打ちかけを置き換えて、後ろに空白を 1 つ足す（後ろが空白なら足さない）', () => {
    expect(insertAt('直して /re', findTrigger('直して /re', 7)!, '/review')).toEqual({ value: '直して /review ', caret: 12 });
    expect(insertAt('@a 続き', findTrigger('@a 続き', 2)!, '@src/app.ts')).toEqual({ value: '@src/app.ts 続き', caret: 12 });
  });
});

describe('Composer の道具の列', () => {
  it('「＋」「/」「@」が並ぶ', () => {
    setup();
    expect(screen.getByRole('button', { name: '画像を添付' })).toHaveTextContent('＋');
    expect(screen.getByRole('button', { name: 'スキルとコマンド' })).toHaveTextContent('/');
    expect(screen.getByRole('button', { name: 'ファイル' })).toHaveTextContent('@');
  });

  it('「/」を押すと、打っている所に / を入れて候補を出す（前が文字なら空白を挟む）', async () => {
    const { ta, type } = setup();
    type('直して');
    fireEvent.click(screen.getByRole('button', { name: 'スキルとコマンド' }));
    expect(ta.value).toBe('直して /');
    await waitFor(() => expect(sheet()).toBeInTheDocument());
  });
});

describe('Composer の / の候補', () => {
  it('行頭で / を打つと、スキルとコマンドの見出しで候補を出す。打った文字で絞り、押すと「/名前 」が入る', async () => {
    const { asker, ta, type } = setup();
    type('/');
    await waitFor(() => expect(within(sheet()!).getByText('スキル')).toBeInTheDocument());
    expect(within(sheet()!).getByText('コマンド')).toBeInTheDocument();
    expect(within(sheet()!).getByText('Mac · アカウント 1 のスキル')).toBeInTheDocument();
    expect(asker.commands).toHaveBeenCalledWith('pc-1', 'p-a', 'acc-1');
    type('/re');
    await waitFor(() => expect(within(sheet()!).queryByRole('button', { name: /\/compact/ })).toBeNull());
    expect(within(sheet()!).getByRole('button', { name: /\/release-notes/ })).toBeInTheDocument();
    fireEvent.click(within(sheet()!).getByRole('button', { name: /\/review/ }));
    expect(ta.value).toBe('/review ');
    await waitFor(() => expect(sheet()).toBeNull());
  });

  it('語の途中の / では出さない', () => {
    const { type } = setup();
    type('a/');
    expect(sheet()).toBeNull();
  });

  it('PC を選んでいなければ「先に PC を選んでください」', async () => {
    const { asker, type } = setup({ pc: null });
    type('/');
    await waitFor(() => expect(within(sheet()!).getByText('先に PC を選んでください')).toBeInTheDocument());
    expect(asker.commands).not.toHaveBeenCalled();
  });

  it('合うものが無ければ、そのまま送れると書く', async () => {
    const { type } = setup();
    type('/zzz');
    await waitFor(() => expect(within(sheet()!).getByText(/「\/zzz」に合うスキルはありません/)).toBeInTheDocument());
  });

  it('×で閉じ、同じ打ちかけの間は出さない', async () => {
    const { type } = setup();
    type('/');
    await waitFor(() => expect(sheet()).toBeInTheDocument());
    fireEvent.click(within(sheet()!).getByRole('button', { name: '候補を閉じる' }));
    await waitFor(() => expect(sheet()).toBeNull());
    type('/r');
    expect(sheet()).toBeNull();
  });
});

describe('Composer の候補の数と形', () => {
  it('空白を含むパスは PC の指示欄と同じく @"…" で入れる', async () => {
    const { ta, type } = setup({ asker: { files: vi.fn(async () => [{ path: 'my notes/a b.md', changed: false }]) } });
    type('@');
    fireEvent.click(await within(sheet()!).findByRole('button', { name: /a b\.md/ }));
    expect(ta.value).toBe('@"my notes/a b.md" ');
  });

  it('描く行は files 50、commands 200 まで。重なった行があっても 1 行にする', async () => {
    const files = Array.from({ length: 60 }, (_, i) => ({ path: `f${i % 55}.ts`, changed: false }));
    const commands = Array.from({ length: 230 }, (_, i) => ({ name: `s${i % 210}`, description: '', kind: 'skill' as const }));
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { type } = setup({ asker: { files: vi.fn(async () => files), commands: vi.fn(async () => commands) } });
    type('@');
    await waitFor(() => expect(within(sheet()!).getAllByRole('button', { name: /\.ts/ })).toHaveLength(50));
    type('/');
    await waitFor(() => expect(within(sheet()!).getAllByRole('button', { name: /^\/s\d+/ })).toHaveLength(200));
    expect(errors.mock.calls.some((c) => String(c[0]).includes('same key'))).toBe(false);
    errors.mockRestore();
  });
});

describe('Composer の @ の候補', () => {
  it('問い合わせ中は骨組み、答えが来たら最近変更したファイル（変更の印）。押すと「@パス 」が入る', async () => {
    let resolve!: (f: FileHit[]) => void;
    const { asker, ta, type } = setup({ asker: { files: vi.fn(() => new Promise<FileHit[]>((r) => (resolve = r))) } });
    type('見て @');
    await waitFor(() => expect(within(sheet()!).getByRole('status')).toHaveTextContent('Mac に問い合わせ中…'));
    await waitFor(() => expect(asker.files).toHaveBeenCalledWith('pc-1', 'p-a', ''));
    await act(async () => resolve(FILES));
    expect(within(sheet()!).getByText('最近変更したファイル')).toBeInTheDocument();
    const row = within(sheet()!).getByRole('button', { name: /app\.ts/ });
    expect(row).toHaveTextContent('変更');
    expect(within(sheet()!).getByRole('button', { name: /README\.md/ })).not.toHaveTextContent('変更');
    fireEvent.click(row);
    expect(ta.value).toBe('見て @src/app.ts ');
  });

  it('打つたびの問い合わせは 250 ms 待ち、最後の q だけを出す', async () => {
    const { asker, type } = setup();
    type('@a');
    type('@ap');
    await waitFor(() => expect(asker.files).toHaveBeenCalledWith('pc-1', 'p-a', 'ap'));
    expect(asker.files).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(within(sheet()!).getByText('「ap」に合うファイル')).toBeInTheDocument());
  });

  it('PC が応答しなければ「PC が応答しません」と再試行', async () => {
    const files = vi.fn<Asker['files']>(async () => {
      throw new AskError('pc-offline', 503);
    });
    const { type } = setup({ asker: { files } });
    type('@');
    await waitFor(() => expect(within(sheet()!).getByText('PC が応答しません')).toBeInTheDocument());
    files.mockResolvedValueOnce(FILES);
    fireEvent.click(within(sheet()!).getByRole('button', { name: 'もう一度' }));
    await waitFor(() => expect(within(sheet()!).getByRole('button', { name: /app\.ts/ })).toBeInTheDocument());
    expect(files).toHaveBeenCalledTimes(2);
  });

  it('5 秒で答えが無いとき（pc-timeout）も「PC が応答しません」', async () => {
    const { type } = setup({ asker: { files: vi.fn(async () => Promise.reject(new AskError('pc-timeout', 504))) } });
    type('@');
    await waitFor(() => expect(within(sheet()!).getByText('PC が応答しません')).toBeInTheDocument());
  });

  it('呼び鈴の口が無いときは「この PC は候補の取得に対応していません」', async () => {
    const { type } = setup({ asker: { commands: vi.fn(async () => Promise.reject(new AskError('unsupported', 404))) } });
    type('/');
    await waitFor(() => expect(within(sheet()!).getByText('この PC は候補の取得に対応していません')).toBeInTheDocument());
    expect(within(sheet()!).getByText(/hangar を更新してください/)).toBeInTheDocument();
  });

  it('クイックセッション（プロジェクトなし）では問い合わせない', async () => {
    const { asker, type } = setup({ projectId: null });
    type('@');
    await waitFor(() => expect(within(sheet()!).getByText(/プロジェクトを選ぶと/)).toBeInTheDocument());
    expect(asker.files).not.toHaveBeenCalled();
  });
});

describe('Composer の画像', () => {
  const item = (over: Partial<Attachment>): Attachment => ({ id: 1, n: 0, name: 'a.jpg', url: 'blob:x/1', data: new Uint8Array(1024 * 1024), mime: 'image/jpeg', state: 'done', pct: 100, ...over });

  it('欄の上にサムネイルを並べ、送信中は進み、失敗はタップで送り直し、×で外す', () => {
    const attachments = noAttachments({
      items: [item({ id: 1, name: 'a.jpg', state: 'up', pct: 40 }), item({ id: 2, name: 'b.jpg', state: 'fail', pct: 60 }), item({ id: 3, name: 'c.jpg' })],
      notice: '画像を 1 枚送信できませんでした。画像をタップすると、もう一度送信します。',
    });
    setup({ attachments });
    const thumbs = screen.getByRole('list', { name: '添付した画像' });
    expect(within(thumbs).getAllByRole('listitem')).toHaveLength(3);
    expect(within(thumbs).getByText('40%')).toBeInTheDocument();
    expect(thumbs.querySelector('img')).toHaveAttribute('src', 'blob:x/1');
    fireEvent.click(within(thumbs).getByRole('button', { name: 'b.jpg をもう一度送信' }));
    expect(attachments.retry).toHaveBeenCalledWith(2);
    fireEvent.click(within(thumbs).getByRole('button', { name: 'c.jpg を削除' }));
    expect(attachments.remove).toHaveBeenCalledWith(3);
    expect(screen.getByText(/画像をタップすると、もう一度送信します/)).toBeInTheDocument();
    expect(screen.getByText('3/4 枚 · 1 枚 5 MB まで')).toBeInTheDocument();
  });

  it('「＋」で写真とカメラのシートを開き、選んだ画像を足す', async () => {
    const attachments = noAttachments();
    setup({ attachments });
    fireEvent.click(screen.getByRole('button', { name: '画像を添付' }));
    const dlg = await screen.findByRole('dialog', { name: '画像を添付' });
    const f = new File([new Uint8Array(3)], 'x.jpg', { type: 'image/jpeg' });
    fireEvent.change(within(dlg).getByLabelText(/写真ライブラリ/), { target: { files: [f] } });
    expect(attachments.add).toHaveBeenCalledWith([f]);
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '画像を添付' })).toBeNull());
  });
});
