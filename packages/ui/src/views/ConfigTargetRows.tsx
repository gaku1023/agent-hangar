import { useState } from 'react';
import type { SettingsDto } from '@agent-hangar/shared';
import { useEmit } from '../action/chain.tsx';
import type { ConfigTargetRowProps } from '../presenters/configSync.ts';
import { Reveal } from './ConfigSyncParts.tsx';
import { Icon } from './primitives/Icon.tsx';
import { useT } from './primitives/language.tsx';
import { Switch } from './primitives/Switch.tsx';

/** 「あとで」で畳んだ知らせ。見る人ごとの便利さなので、ブラウザの保存先に置き、読めなければ毎回出す。 */
const LATER_KEY = 'hangar.configTargets.newLater';
const readLater = (): boolean => { try { return localStorage.getItem(LATER_KEY) === '1'; } catch { return false; } };
const writeLater = (): void => { try { localStorage.setItem(LATER_KEY, '1'); } catch { /* 保存できなくても畳むだけ */ } };

/**
 * 設定の同期の親スイッチの下に並べる、対象ごとの入切（U0 の 1A、1α、2A、2a）。
 * - 行は名前、札（Git などで管理、承諾制、新）、説明、スイッチ。入切は settings の configTargets 全体を、その対象だけ替えて保存する。
 * - Git などで管理された入れ物の対象を有効にするときは、行の下に確認の帯を出し、「有効にする」を押すまで保存しない。
 * - 0.12 で増えた対象は無効のまま「新」の札を付け、どれもまだ選んでいなければ上に知らせの帯を出す。
 */
export function ConfigTargetRows(props: { rows: ConfigTargetRowProps[]; showNew: boolean; switches: Record<string, boolean> }) {
  const t = useT();
  const emit = useEmit();
  const [confirm, setConfirm] = useState<string | null>(null);
  const [later, setLater] = useState(readLater);
  const save = (next: Record<string, boolean>) => emit({ type: 'settings.update', patch: { configTargets: next } as unknown as Partial<SettingsDto> });
  const set = (name: string, on: boolean) => { setConfirm(null); save({ ...props.switches, [name]: on }); };
  const toggle = (r: ConfigTargetRowProps, next: boolean) => {
    if (next && r.vcs) { setConfirm(r.name); return; }
    set(r.name, next);
  };
  const enableAll = () => {
    const next = { ...props.switches };
    for (const r of props.rows) if (r.isNew && !r.vcs) next[r.name] = true;
    save(next);
  };
  return (
    <div className="cfg-kids">
      <Reveal open={props.showNew && !later}>
        <div className="cfg-strip" data-tone="info">
          <Icon name="sync" />
          <span><b>{t('configTargetsUi.new.title')}</b>{' '}{t('configTargetsUi.new.body')}{' '}{t('configTargetsUi.new.gitNote')}</span>
          <span className="spacer" />
          <span className="cfg-strip-acts">
            <button type="button" className="btn btn-sm btn-primary" onClick={enableAll}>{t('configTargetsUi.new.all')}</button>
            <button type="button" className="btn btn-sm" onClick={() => { writeLater(); setLater(true); }}>{t('configTargetsUi.new.later')}</button>
          </span>
        </div>
      </Reveal>
      <div className="cfg-kids-h">{t('configTargetsUi.kids.head')}</div>
      {props.rows.map((r) => (
        <div key={r.name} className="cfg-cr" data-target={r.name}>
          <div className="cfg-cr-main">
            <div className="cfg-cr-l">
              <div className="cfg-cr-t">
                {r.title}
                {r.vcs && <span className="cfg-act" data-a="kind" title={r.vcs.tip}>{r.vcs.chip}</span>}
                {r.approve && <span className="cfg-act" data-a="hook" title={t('configTargetsUi.tag.approveTip')}>{t('configTargetsUi.tag.approve')}</span>}
                {r.isNew && <span className="cfg-act" data-a="create">{t('configTargetsUi.tag.new')}</span>}
              </div>
              <div className="cfg-cr-d">{r.desc}</div>
              {r.notice && <div className="cfg-cr-d cfg-cr-warn">{r.notice}</div>}
            </div>
            <Switch label={r.title} checked={r.on} onChange={(v) => toggle(r, v)} />
          </div>
          <Reveal open={confirm === r.name && r.vcs !== null} className="cfg-cr-slot">
            {r.vcs && (
              <div className="cfg-strip" data-tone="danger" role="group" aria-label={r.vcs.title}>
                <Icon name="alert" />
                <span><b>{r.vcs.title}</b>{' '}{r.vcs.body}</span>
                <span className="spacer" />
                <span className="cfg-strip-acts">
                  <button type="button" className="btn btn-sm" onClick={() => setConfirm(null)}>{t('common.button.cancel')}</button>
                  <button type="button" className="btn btn-sm btn-primary" onClick={() => set(r.name, true)}>{t('configTargetsUi.git.ok')}</button>
                </span>
              </div>
            )}
          </Reveal>
        </div>
      ))}
    </div>
  );
}
