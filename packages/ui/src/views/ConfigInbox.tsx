import { useState } from 'react';
import type { ConfigApplyOrderEntryIn } from '@agent-hangar/shared';
import { useEmit } from '../action/chain.tsx';
import type { HistoryBatchProps, InboxProps } from '../presenters/configKinds.ts';
import { Reveal } from './ConfigSyncParts.tsx';
import { TriSwitch } from './ConfigTriSwitch.tsx';
import { Icon } from './primitives/Icon.tsx';
import { useT } from './primitives/language.tsx';

/** 項目の操作の記号。 */
const OP_MARK = { create: '+', overwrite: '~', delete: '−', conflict: '!' } as const;

/**
 * 設定の同期の右の列「届いたもの」。確認、競合、履歴を縦に並べる。
 * - 確認：承認の流れ（承認のダイアログ）につなぐ。
 * - 競合：手元か相手を選んで「決める」。選んだ側で適用する。
 * - 履歴：1 回ごとに開き、まとめて戻す、1 項目ずつ戻す。戻したものは線を引く。開いたときに、自動で入った回を見たことにする。
 * 戻す入口は、殻が履歴の戻しを持つときだけ出す（presenter の canRestore）。
 */
export function ConfigInbox(props: { inbox: InboxProps }) {
  const t = useT();
  const emit = useEmit();
  const ib = props.inbox;
  const [open, setOpen] = useState<number | null>(null);
  const [take, setTake] = useState<Readonly<Record<string, 'mine' | 'remote'>>>({});
  const toggle = (h: HistoryBatchProps) => {
    const next = open === h.id ? null : h.id;
    setOpen(next);
    if (next !== null && ib.unseen > 0) emit({ type: 'configSync.history.seen' });
  };
  const decide = (id: string) => {
    const side = take[id];
    if (!side) return;
    const entries: ConfigApplyOrderEntryIn[] = [{ id, take: side === 'remote' ? 'remote' : 'mine' }];
    emit({ type: 'configSync.resolve', entries });
  };
  return (
    <section className="cfg-inbox" aria-labelledby="cfg-inbox-h">
      <h3 className="h2" id="cfg-inbox-h">{t('configKindsUi.inbox.title')}</h3>
      {ib.autoError !== null && <div className="cfg-strip" data-tone="danger" role="status"><Icon name="alert" /><span>{ib.autoError}</span></div>}
      <Reveal open={ib.ask.length > 0 || ib.conflicts.length > 0}>
        <div className="ib-ask">
          {ib.ask.length > 0 && (
            <div className="ib-g">
              <div className="ib-h"><Icon name="alert" /><span>{t('configKindsUi.inbox.ask')}</span><span className="ib-end"><button type="button" className="btn btn-sm btn-primary" onClick={() => emit({ type: 'configSync.open', part: 'approve' })}>{t('configKindsUi.inbox.apply')}</button></span></div>
              {ib.ask.map((a) => <div key={a.id} className="ib-it"><span className="ib-t">{a.label}</span><span className="ib-k">{a.kind}</span></div>)}
            </div>
          )}
          {ib.conflicts.length > 0 && (
            <div className="ib-g">
              <div className="ib-h"><span>{t('configKindsUi.inbox.conflict')}</span></div>
              {ib.conflicts.map((c) => (
                <div key={c.id} className="ib-it">
                  <span className="ib-t">{c.label}</span>
                  <TriSwitch label={c.label} value={take[c.id] ?? 'mixed'} tone={take[c.id] === 'remote' ? 'auto' : 'off'}
                    options={[{ value: 'mine', label: t('configKindsUi.inbox.mine') }, { value: 'remote', label: t('configKindsUi.inbox.remote') }]}
                    onChange={(v) => setTake((s) => ({ ...s, [c.id]: v }))} />
                  <button type="button" className="btn btn-sm btn-primary" disabled={!take[c.id]} onClick={() => decide(c.id)}>{t('configKindsUi.inbox.decide')}</button>
                </div>
              ))}
            </div>
          )}
        </div>
      </Reveal>
      <div className="ib-hist">
        {ib.history.map((h) => (
          <div key={h.id} className="ib-batch" data-open={open === h.id ? '' : undefined} data-unseen={h.unseen ? '' : undefined}>
            <button type="button" className="ib-bh" aria-expanded={open === h.id} aria-label={t('configKindsUi.history.toggle', { when: h.when, from: h.from ?? '' })} onClick={() => toggle(h)}>
              <Icon name="chevron" />
              <span className="ib-when">{h.when}</span>
              <span className="ib-from">{h.from}</span>
              <span className="ib-kinds">{h.kinds}</span>
            </button>
            <Reveal open={open === h.id}>
              <div className="ib-body">
                {h.items.map((i) => (
                  <div key={i.id} className="ib-it" data-undone={i.undone ? '' : undefined}>
                    <span className="ib-op" data-op={i.op} aria-hidden="true">{OP_MARK[i.op]}</span>
                    <span className="ib-t">{i.label}</span>
                    <span className="ib-k">{i.kind}</span>
                    {i.canUndo && <button type="button" className="btn btn-sm btn-ghost" aria-label={t('configKindsUi.history.undoItem', { name: i.label })} onClick={() => emit({ type: 'configSync.history.restore', history: h.id, item: i.id })}><Icon name="reset" /></button>}
                  </div>
                ))}
                {h.canUndoBatch && <div className="ib-acts"><button type="button" className="btn btn-sm" onClick={() => emit({ type: 'configSync.history.restore', history: h.id })}><Icon name="reset" />{t('configKindsUi.history.undoBatch')}</button></div>}
              </div>
            </Reveal>
          </div>
        ))}
      </div>
    </section>
  );
}
