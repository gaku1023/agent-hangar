import { useEffect, useState } from 'react';
import { useEmit } from '../intent/chain.tsx';
import type { ConfigSyncSectionProps } from '../presenters/configSync.ts';
import { ConfigRow } from './ConfigSyncParts.tsx';
import { CommandLine } from './primitives/CommandLine.tsx';
import { Icon } from './primitives/Icon.tsx';
import { useT } from './primitives/language.tsx';
import { Segmented } from './primitives/Segmented.tsx';
import { SetRow } from './primitives/SetRow.tsx';
import { revealWithin } from './primitives/revealWithin.ts';
import { Switch } from './primitives/Switch.tsx';

/**
 * 設定の「クラウド同期」の節の中の、Claude Code の設定の同期（作り直した実装。段 4 の PR 17）。
 * 送るものと適用の中身はダイアログで見せる（ConfigSyncDialog）。ここは常設の行だけを持つ。
 *
 * - 有効にする：入れるときは、送るものの一覧を見せて承諾を取る。切るのはその場で保存する。
 * - 届いている変更、承諾待ち、競合：押すとそれぞれのダイアログを開く。
 * - 承諾の仕方：自動に切り替えるときは、その場に注意の文と、やめる、自動にする、を出す。
 * - 送らなかった項目：件数が 0 でも行を残し、開くと理由と「それでも送る」を出す（e2）。
 * - バックアップ：書き込みの前の世代。戻す操作は殻のネイティブの確認を経る（殻が無ければコマンドを案内する）。
 */
export function ConfigSyncSection(props: { cfg: ConfigSyncSectionProps; cloudOff: boolean }) {
  const t = useT();
  const emit = useEmit();
  const c = props.cfg;
  // 自動に切り替える前の注意の帯。承諾の仕方は、利用者が「自動にする」を押すまで変えない。
  const [askAuto, setAskAuto] = useState(false);
  const [unsentOpen, setUnsentOpen] = useState(c.focusUnsent);
  // ベルの一覧の行から来たときは、送らなかった項目の行を開いて、見える所へ移る。行は節が揃ってから出るので、出たときにも見直す。
  const showUnsent = c.enabled && !props.cloudOff && !c.needsCloud && c.unsent.count > 0;
  useEffect(() => {
    if (!c.focusUnsent || !showUnsent) return;
    setUnsentOpen(true);
    // scrollIntoView は WebKit で外箱まで動かすので、頁をスクロールする枠の中だけを動かす。
    const row = document.getElementById('settings-config-unsent');
    const box = row?.closest<HTMLElement>('.main');
    if (row && box) revealWithin(box, row);
  }, [c.focusUnsent, showUnsent]);
  const [backupsOpen, setBackupsOpen] = useState(false);
  const off = props.cloudOff || c.needsCloud;
  const on = c.enabled && !off;

  const toggle = (next: boolean) => {
    if (next) emit({ type: 'configSync.open', part: 'send' });
    else emit({ type: 'settings.update', patch: { configBundleSync: false } });
  };

  return (
    <section aria-labelledby="settings-config-h">
      <h3 className="h2" id="settings-config-h">{t('settings.cloud.config.title')}</h3>
      <SetRow title={t('settings.cloud.config.enable')}
        desc={off ? t('settings.cloud.config.needsCloud') : (
          <>
            {t('configSyncUi.section.desc')}
            {on && (
              <div className="cfg-line">
                {c.lastSent !== null ? t('configSyncUi.section.lastSent', { time: c.lastSent }) : t('configSyncUi.section.notSentYet')}
                <button type="button" className="btn btn-sm btn-ghost" onClick={() => emit({ type: 'configSync.open', part: 'send' })}>{t('configSyncUi.section.showOutgoing')}</button>
              </div>
            )}
          </>
        )}
        control={<Switch label={t('settings.cloud.config.enable')} checked={on} disabled={off} onChange={toggle} />}
        below={on && c.workerPending ? (
          <div className="cfg-strip" data-tone="warn" role="status">
            <Icon name="alert" />
            <span><b>{t('configSyncUi.worker.title')}</b>{' '}{t('configSyncUi.worker.body')}</span>
          </div>
        ) : undefined} />
      {on && (
        <>
          {c.order && (
            <SetRow title={t('configSyncUi.order.title')}
              desc={t('configSyncUi.order.desc', { n: c.order.count, when: c.order.when })}
              control={(
                <>
                  <button type="button" className="btn btn-sm" onClick={() => emit({ type: 'configSync.order.cancel' })}>{t('configSyncUi.order.cancel')}</button>
                  {c.native && <button type="button" className="btn btn-sm btn-primary" onClick={() => emit({ type: 'configSync.order.apply' })}>{t('configSyncUi.word.apply')}</button>}
                </>
              )}
              below={c.native ? undefined : (
                <>
                  <div className="set-row-d">{t('configSyncUi.order.terminal')}</div>
                  <CommandLine command={c.order.command} />
                </>
              )} />
          )}
          <SetRow title={t('configSyncUi.incoming.title')}
            desc={c.incoming.count + c.incoming.held === 0 ? t('configSyncUi.incoming.none')
              : [
                c.incoming.count > 0 ? (c.incoming.from ? t('configSyncUi.incoming.from', { n: c.incoming.count, from: c.incoming.from }) : t('configSyncUi.word.count', { n: c.incoming.count })) : null,
                c.incoming.held > 0 ? t('configSyncUi.incoming.held', { n: c.incoming.held }) : null,
              ].filter((x) => x !== null).join(t('configSyncUi.incoming.sep'))}
            control={<button type="button" className="btn btn-sm btn-primary" disabled={c.incoming.count + c.incoming.held === 0} onClick={() => emit({ type: 'configSync.open', part: 'review' })}>{t('configSyncUi.incoming.review')}</button>} />
          {c.awaiting > 0 && (
            <SetRow title={t('configSyncUi.awaiting.title', { n: c.awaiting })} desc={t('configSyncUi.awaiting.desc')}
              control={<button type="button" className="btn btn-sm" onClick={() => emit({ type: 'configSync.open', part: 'approve' })}>{t('configSyncUi.awaiting.open')}</button>} />
          )}
          <SetRow title={t('configSyncUi.approval.title')} desc={c.approval === 'auto' ? t('configSyncUi.approval.descAuto') : t('configSyncUi.approval.desc')}
            control={(
              <Segmented label={t('configSyncUi.approval.title')} value={c.approval}
                options={[{ value: 'each', label: t('configSyncUi.approval.each') }, { value: 'auto', label: t('configSyncUi.approval.auto') }]}
                onChange={(v) => {
                  if (v === 'auto') setAskAuto(true);
                  else { setAskAuto(false); emit({ type: 'settings.update', patch: { configApproval: 'each' } }); }
                }} />
            )}
            below={askAuto && c.approval !== 'auto' ? (
              <div className="cfg-strip" data-tone="danger" role="group" aria-label={t('configSyncUi.approval.confirmLabel')}>
                <Icon name="alert" />
                <span>{t('configSyncUi.approval.warn')}</span>
                <span className="spacer" />
                <button type="button" className="btn btn-sm" onClick={() => setAskAuto(false)}>{t('common.button.cancel')}</button>
                <button type="button" className="btn btn-sm btn-primary" onClick={() => { setAskAuto(false); emit({ type: 'settings.update', patch: { configApproval: 'auto' } }); }}>{t('configSyncUi.approval.makeAuto')}</button>
              </div>
            ) : undefined} />
          <SetRow title={t('configSyncUi.conflicts.title', { n: c.conflicts })} desc={c.conflicts === 0 ? t('configSyncUi.conflicts.none') : t('configSyncUi.conflicts.desc')}
            control={<button type="button" className="btn btn-sm" disabled={c.conflicts === 0} onClick={() => emit({ type: 'configSync.open', part: 'conflicts' })}>{t('configSyncUi.conflicts.open')}</button>} />
          {/* 送らなかった項目は、0 件でも行を残す（e2）。送った直後の知らせはベルの一覧に入る（段 4 の PR 19）。 */}
          <SetRow id="settings-config-unsent" title={t('configSyncUi.unsent.title', { n: c.unsent.count })} desc={t('configSyncUi.unsent.desc')}
            control={<button type="button" className="btn btn-sm" aria-expanded={unsentOpen && c.unsent.count > 0} disabled={c.unsent.count === 0} onClick={() => setUnsentOpen(!unsentOpen)}>{unsentOpen && c.unsent.count > 0 ? t('configSyncUi.word.fold') : t('configSyncUi.word.show')}</button>}
            below={unsentOpen && c.unsent.count > 0 ? (
              <div className="cfg-list">
                {c.unsent.rows.length === 0 && <div className="faint">{t('settings.common.loading')}</div>}
                {c.unsent.rows.map((r) => (
                  <ConfigRow key={r.id} row={r}
                    action={r.sendId !== null ? <button type="button" className="btn btn-sm" aria-label={t('configSyncUi.unsent.sendAnyway.label', { name: r.label })} onClick={() => emit({ type: 'configSync.unsent.send', id: r.sendId! })}>{t('configSyncUi.unsent.sendAnyway')}</button> : undefined} />
                ))}
              </div>
            ) : undefined} />
          <SetRow title={t('configSyncUi.backups.title', { n: c.backups.count })} desc={t('configSyncUi.backups.desc')}
            control={<button type="button" className="btn btn-sm" aria-expanded={backupsOpen && c.backups.count > 0} disabled={c.backups.count === 0} onClick={() => setBackupsOpen(!backupsOpen)}>{backupsOpen && c.backups.count > 0 ? t('configSyncUi.word.fold') : t('configSyncUi.word.show')}</button>}
            below={backupsOpen && c.backups.count > 0 ? (
              <div className="cfg-list">
                {c.backups.rows.length === 0 && <div className="faint">{t('settings.common.loading')}</div>}
                {c.backups.rows.map((g) => (
                  <div key={g.name} className="cfg-it cfg-gen">
                    <span className="cfg-k mono">{g.when}</span>
                    <span />
                    <span className="cfg-r">
                      <span className="cfg-side">{g.files}</span>
                      {c.native
                        ? <button type="button" className="btn btn-sm" aria-label={t('configSyncUi.backups.restore.label', { when: g.when })} onClick={() => emit({ type: 'configSync.restore', name: g.name })}>{t('configSyncUi.backups.restore')}</button>
                        : <CommandLine command={g.command} />}
                    </span>
                  </div>
                ))}
                {!c.native && <div className="set-row-d">{t('configSyncUi.backups.terminal')}</div>}
              </div>
            ) : undefined} />
        </>
      )}
    </section>
  );
}
