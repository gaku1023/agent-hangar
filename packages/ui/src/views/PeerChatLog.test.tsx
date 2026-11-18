import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { PeerChatRow } from '../presenters/peerChat.ts';
import { LanguageRoot } from './primitives/language.tsx';
import { PeerChatLog } from './PeerChatLog.tsx';

afterEach(cleanup);

const rows: PeerChatRow[] = [
  { kind: 'assistant', key: 'a1', text: '見ます' },
  { kind: 'tools', key: 't1', label: 'ツール呼び出し 2 回', failed: null, items: [
    { key: 't1', name: 'Bash', summary: 'ssh vm systemctl', ok: true },
    { key: 't2', name: 'notify_user', summary: '', ok: true },
  ] },
  { kind: 'tool', key: 't3', name: 'Read', summary: '', ok: true },
];
const draw = () => render(<LanguageRoot language="ja"><PeerChatLog rows={rows} loading={false} onCancel={() => {}} onAnswer={() => {}} /></LanguageRoot>);

describe('別の PC の会話の列のツールのまとめ', () => {
  it('畳んだ行は件数だけで、押すと 1 本ずつの行が開き、もう一度押すと畳む', () => {
    draw();
    const row = screen.getByRole('button', { name: /ツール呼び出し 2 回/ });
    expect(row.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('ssh vm systemctl', { exact: false })).toBeNull();
    fireEvent.click(row);
    expect(row.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('notify_user')).toBeTruthy();
    expect(screen.getByText('ssh vm systemctl', { exact: false })).toBeTruthy();
    fireEvent.click(row);
    expect(row.getAttribute('aria-expanded')).toBe('false');
  });
  it('要旨の無い単独のツールは名前だけを出す', () => {
    draw();
    expect(screen.getByText('Read').parentElement!.textContent).toBe('Read');
  });
});
