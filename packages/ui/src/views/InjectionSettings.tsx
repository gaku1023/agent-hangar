import type { ReactNode } from 'react';
import { useEmit } from '../action/chain.tsx';
import type { InjectionSettingsProps } from '../presenters/settings.ts';
import { InjectionFull } from './InjectionFull.tsx';
import { Icon, type IconName } from './primitives/Icon.tsx';
import { InfoTip } from './primitives/InfoTip.tsx';
import { useT } from './primitives/language.tsx';
import { SetRow } from './primitives/SetRow.tsx';
import { Switch } from './primitives/Switch.tsx';

/** 足すものの 1 行。always は切れないものに添える「常に」の札。info は見出しの横の ⓘ に畳む説明。 */
function AddItem(props: { icon: IconName; title: string; info?: string; always?: boolean; children?: ReactNode }) {
  const t = useT();
  return (
    <li className="add-item">
      <Icon name={props.icon} />
      <div>
        <div className="add-t">{props.title}{props.info && <InfoTip label={props.title}>{props.info}</InfoTip>}</div>
      </div>
      {props.always ? <span className="always">{t('settings.integrations.inject.always')}</span> : <span />}
      {props.children && <div className="add-nest">{props.children}</div>}
    </li>
  );
}

/**
 * セッションの小節「Claude Code に渡す設定」（試作 1 節の推す案 B）。
 * MCP の設定と hook は hangar の基本なので切れず、「常に」を添える。
 * スイッチ 2 つと全文の畳みは「システムプロンプトの追記」の行の中に字下げして置き、スイッチが追記の一部だけに効くことを形で見せる。
 * Remote Control と既定のモデルは追記とは別のもので、新しいセッションの小節に置く（2026-10-25 の並び替え）。どれも選んだ時点で保存する。
 * 全文は辞書の 3 つの鍵を画面の言語で埋めたもの（presenters/injection.ts）で、切った段は打ち消し線で残す。
 */
export function InjectionSettings(props: { injection: InjectionSettingsProps }) {
  const t = useT();
  const emit = useEmit();
  const i = props.injection;
  const title = t('settings.integrations.inject.title');
  return (
    <section aria-label={title}>
      <h3 className="h2">{title}<InfoTip label={title}>{t('settings.integrations.inject.lead')}{' '}{t('settings.integrations.inject.note')}</InfoTip></h3>
      <ul className="add-list">
        <AddItem icon="link" title={t('settings.integrations.inject.mcp.title')} info={t('settings.integrations.inject.mcp.desc')} always />
        <AddItem icon="bell" title={t('settings.integrations.inject.hook.title')} always />
        <AddItem icon="fullText" title={t('settings.integrations.inject.prompt.title')} info={t('settings.integrations.inject.prompt.desc')}>
          <SetRow title={t('settings.label.askStatusAtEnd')} info={t('settings.integrations.inject.askStatus.desc')}
            control={<Switch label={t('settings.label.askStatusAtEnd')} checked={i.askStatusAtEnd} onChange={(next) => emit({ type: 'settings.update', patch: { askStatusAtEnd: next } })} />} />
          <SetRow title={t('settings.label.liveHints')} info={t('settings.integrations.inject.liveHints.desc')}
            control={<Switch label={t('settings.label.liveHints')} checked={i.liveHints} onChange={(next) => emit({ type: 'settings.update', patch: { liveHints: next } })} />} />
          <InjectionFull parts={i.full} />
        </AddItem>
      </ul>
    </section>
  );
}
