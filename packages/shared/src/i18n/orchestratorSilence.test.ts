import { describe, expect, it } from 'vitest';
import { en } from './en.ts';
import { ja } from './ja.ts';

/** 統括の役の文は、画面に出ない返答を書かせず、一度伝えた待ちを繰り返させない（日本語と英語の両方）。 */
describe('統括の役の文', () => {
  it('notify_user のあとは返答を書かずに終える', () => {
    expect(ja['launch.injection.orchestrator']).toContain('notify_user を呼んだあとは返答を書かずにターンを終えてください');
    expect(en['launch.injection.orchestrator']).toContain('after notify_user end the turn without writing one');
  });
  it('伝えた待ちは、まだ一覧に載っていても、もう一度伝えない', () => {
    expect(ja['launch.injection.orchestrator']).toContain('list_pending_asks にまだ載っていても、もう一度伝えません');
    expect(en['launch.injection.orchestrator']).toContain('is not told again, even if it still appears in list_pending_asks');
  });
  it('同じ決まりの文が重ならない', () => {
    expect(ja['launch.injection.orchestrator']!.split('自分で片付けた許可は伝えません').length).toBe(1);
    expect(en['launch.injection.orchestrator']!.split('Do not report a permission you').length).toBe(2);
  });
});
