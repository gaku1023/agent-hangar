import { useState } from 'react';
import { useEmit } from '../action/chain.tsx';
import type { LinkRepairProps } from '../presenters/linkRepair.ts';
import { InvestigateButton } from './InvestigateButton.tsx';
import { Dialog } from './primitives/Dialog.tsx';
import { Icon } from './primitives/Icon.tsx';
import { useT } from './primitives/language.tsx';

const MARK = { ctx: ' ', add: '+', del: '-' } as const;

type Keep = 'mine' | 'shared';

/**
 * 共有のリンクが実ファイルに置き換わった衝突の修復（#513、試作の A）。
 * 設定の同期の競合のダイアログ（ConfigSyncDialog の ConflictsDialog）と同じ形で、ファイルごとに 1 枚の札を置き、差分を最初から出す。
 * 差分は共有設定から、このアカウントのファイルへの行の差分で、赤は共有にだけあり、緑はこのアカウントにだけある。
 * 全部の札で残す側を選ぶまで「修復」は押せない。選ばなかった側は、サーバが名前に .bak-hangar-日時 を付けて残す。
 */
export function LinkRepairDialog(props: LinkRepairProps) {
  const t = useT();
  const emit = useEmit();
  const [keep, setKeep] = useState<Readonly<Record<string, Keep>>>({});
  // 取り直しで消えた項目は、選んだ数から外す。
  const entries = props.cards.filter((c) => keep[c.name] !== undefined).map((c) => ({ name: c.name, keep: keep[c.name]! }));
  const all = props.cards.length > 0 && entries.length === props.cards.length;
  const close = () => { if (!props.working) emit({ type: 'overlay.close' }); };
  const pick = (name: string, side: Keep) => setKeep((s) => (s[name] === side ? Object.fromEntries(Object.entries(s).filter(([k]) => k !== name)) : { ...s, [name]: side }));
  return (
    <Dialog title={t('account.repair.title', { account: props.account })} icon="sync" className="dialog-config" onClose={close}
      footer={(
        <>
          <InvestigateButton ctx={props.investigate} link />
          <span className="faint cfg-backup">{t('account.repair.note')}</span>
          <span className="faint">{t('account.repair.selected', { n: props.cards.length, m: entries.length })}</span>
          <span className="spacer" />
          <button type="button" className="btn" disabled={props.working} onClick={close}>{t('common.button.cancel')}</button>
          <button type="button" className="btn btn-primary" disabled={props.working || !all} onClick={() => emit({ type: 'linkRepair.apply', entries })}>{props.working ? t('account.repair.working') : t('account.repair.submit')}</button>
        </>
      )}>
      <div className="muted">{props.loading ? t('settings.common.loading') : t('account.repair.lead', { names: props.names })}</div>
      {props.cards.map((c) => (
        <div key={c.name} className="cfg-card">
          <div className="cfg-card-t mono">{c.name}</div>
          <p className="cfg-card-d">{t('account.repair.when', { mine: c.mineWhen, shared: c.sharedWhen })}</p>
          {c.lines === null
            ? <div className="faint cfg-diff">{t('account.repair.noDiff')}</div>
            : (
              <div className="diff mono cfg-diff" role="group" aria-label={t('account.repair.diff', { name: c.name })}>
                {c.lines.map((l, i) => <div key={i} className={`diff-${l.kind}`}>{MARK[l.kind]} {l.text}</div>)}
              </div>
            )}
          <div className="btns">
            <button type="button" className="btn btn-sm" aria-pressed={keep[c.name] === 'mine'} disabled={props.working} onClick={() => pick(c.name, 'mine')}>{keep[c.name] === 'mine' && <Icon name="check" />}{t('account.repair.keepMine')}</button>
            <button type="button" className="btn btn-sm" aria-pressed={keep[c.name] === 'shared'} disabled={props.working} onClick={() => pick(c.name, 'shared')}>{keep[c.name] === 'shared' && <Icon name="check" />}{t('account.repair.keepShared')}</button>
          </div>
        </div>
      ))}
      {props.error !== null && <div className="error" role="alert">{props.error}</div>}
    </Dialog>
  );
}
