import { fireEvent, render, screen } from '@testing-library/react';
import { translator, type Intent } from '@agent-hangar/shared';
import { describe, expect, it, vi } from 'vitest';
import { IntentRoot } from '../intent/chain.tsx';
import { presentSessionBadges } from '../presenters/session.ts';
import { LanguageRoot } from './primitives/language.tsx';
import { SessionBadges } from './SessionBadges.tsx';
import { TocPane, TocToggle } from './TocPane.tsx';

const ja = translator('ja');
const NOW = Date.UTC(2026, 9, 9, 3, 0, 0);
const session = (p: object) => p as Parameters<typeof presentSessionBadges>[0];

describe('SessionBadges（見出しの名前の横の札）', () => {
  it('ロックの札は、ロックの文と種類を出し、最終確認を title と読み上げに入れる', () => {
    const badges = presentSessionBadges(session({ lock: { deviceId: 'd2', deviceName: 'office-pc', runId: 'r', heartbeatAt: NOW - 5 * 60_000, stale: false }, remoteOnly: false }), NOW, ja);
    render(<SessionBadges badges={badges} />);
    const chip = screen.getByText('office-pc で実行中');
    expect(chip).toHaveAttribute('data-kind', 'lock');
    expect(chip).toHaveAttribute('title', '最終確認 5 分前');
    expect(chip).toHaveTextContent('office-pc で実行中、最終確認 5 分前');
  });

  it('応答が途絶えたロックは stale、トランスクリプトが他の PC にあるときは remote の札で、両方あれば 2 つ並ぶ', () => {
    const badges = presentSessionBadges(session({ lock: { deviceId: 'd2', deviceName: 'office-pc', runId: 'r', heartbeatAt: NOW - 60 * 60_000, stale: true }, remoteOnly: true }), NOW, ja);
    const { container } = render(<SessionBadges badges={badges} />);
    expect([...container.querySelectorAll('.session-badge')].map((b) => [b.getAttribute('data-kind'), b.firstChild?.textContent])).toEqual([['stale', 'office-pc から応答がありません'], ['remote', 'トランスクリプトは他の PC にあります']]);
  });

  it('札が無ければ何も描かない', () => {
    const { container } = render(<SessionBadges badges={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('TocPane（目次だけの右パネル）', () => {
  it('「目次」の名前を持つ aside に、中身をそのまま入れる', () => {
    render(<LanguageRoot language="ja"><TocPane><div>ターンの一覧</div></TocPane></LanguageRoot>);
    expect(screen.getByRole('complementary', { name: '目次' })).toHaveTextContent('ターンの一覧');
  });

  it('開閉のボタンは、開いていれば「閉じる」、閉じていれば「開く」の名前で、押すと transcript.toggle を出す', () => {
    const onIntent = vi.fn<(i: Intent) => void>();
    const { rerender } = render(<LanguageRoot language="ja"><IntentRoot onIntent={onIntent}><TocToggle open /></IntentRoot></LanguageRoot>);
    const btn = screen.getByRole('button', { name: '右パネルを閉じる' });
    expect(btn).toHaveAttribute('title', '右パネルの開閉（⌘J）');
    fireEvent.click(btn);
    expect(onIntent).toHaveBeenCalledWith({ type: 'transcript.toggle' });
    rerender(<LanguageRoot language="ja"><IntentRoot onIntent={onIntent}><TocToggle open={false} /></IntentRoot></LanguageRoot>);
    expect(screen.getByRole('button', { name: '右パネルを開く' })).toBeInTheDocument();
  });
});
