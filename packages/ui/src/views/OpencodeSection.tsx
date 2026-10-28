import { useLayoutEffect, useRef } from 'react';
import type { OpencodeInjection } from '@agent-hangar/shared';
import { useEmit } from '../action/chain.tsx';
import type { OpencodeProvidersProps } from '../presenters/opencodeProviders.ts';
import type { OpencodeSettingsProps } from '../presenters/settings.ts';
import { InjectionFull } from './InjectionFull.tsx';
import { OpencodeProviders } from './OpencodeProviders.tsx';
import { Icon } from './primitives/Icon.tsx';
import { useT } from './primitives/language.tsx';
import { Listbox } from './primitives/Listbox.tsx';
import { collapseOut, fadeIn, fadeOut, growIn, motionOn } from './primitives/motionKit.ts';
import { StepSlider } from './primitives/StepSlider.tsx';
import { SetRow } from './primitives/SetRow.tsx';
import { Switch } from './primitives/Switch.tsx';
import { usePresence } from './primitives/usePresence.ts';

/** 版の行の本文。手元の版と確かめた範囲を並べ、範囲の外や見つからないときはその下に文を添える。届く前は「読み込み中…」。 */
function OpencodeVersion(props: { version: OpencodeSettingsProps['version'] }) {
  const t = useT();
  const v = props.version;
  if (v === null) return <span>{t('settings.common.loading')}</span>;
  return (
    <>
      {v.kind !== 'missing' && (
        <span className="oc-vers">
          {v.installed !== null && <>{t('settings.opencode.version.installed')} <code>{v.installed}</code>{' · '}</>}
          {t('settings.opencode.version.verified')} <code>{v.verified}</code>
        </span>
      )}
      {v.note && <span className="oc-note" data-tone={v.kind === 'unverified' || v.kind === 'unknown' ? 'info' : 'warn'}>{v.note}</span>}
    </>
  );
}

/**
 * 設定の「連携 › opencode」（ベータ、試作の D1）。Claude Code との互換性の節のすぐ下に置く。
 * 有効にする行だけを常に出し、入れたときだけバージョンとシステムプロンプトへの追記の行を growIn で伸ばして入れる（切ると collapseOut で畳んでから外す）。
 * 見出しの右端の札も入のときだけ出し、fadeIn と fadeOut で出入りさせる。
 * 入のときの行は、バージョン、コマンドの横取り（段 D2、macOS と Linux だけ）、コマンドの実行前の確認（許可のひな形）、システムプロンプトへの追記の順。
 * 実行前の確認は、利用者の opencode.json が許可を決めていればスイッチを無効にし、注記を出す（試作 S4 の案 A）。
 * 追記の行の下には、選んでいる量で送る全文の畳みを Claude の「システムプロンプトの追記」と同じ形で置く（views/InjectionFull.tsx）。追記しないときは出さない。
 * その下に「プロバイダー」（つないだ先と追加、views/OpencodeProviders.tsx）を置く。providers を渡さなければ出さない。
 * available が偽なら面ごと出さない（いまはどの OS でも真）。横取りの行は Windows では出さない（intercept.available）。どれも選んだ時点で保存する。
 */
export function OpencodeSection(props: { o: OpencodeSettingsProps; providers?: OpencodeProvidersProps; /** 偽なら見出しの名前とベータの札を出さない（設定の節の見出しがすでに言うとき）。既定は真。 */ showTitle?: boolean }) {
  const t = useT();
  const emit = useEmit();
  const o = props.o;
  const more = usePresence<HTMLDivElement>(o.enabled, (el) => (motionOn(el) ? collapseOut(el) : null));
  const showBadge = o.enabled && o.badge !== null;
  const badge = usePresence<HTMLSpanElement>(showBadge, (el) => (motionOn(el) ? fadeOut(el) : null));
  // 最後に出した札。消える動きの間は、その姿のまま薄れさせる。
  const lastBadge = useRef(o.badge);
  if (o.badge) lastBadge.current = o.badge;
  // 最初の描画では動かさない（設定を開いたときに伸びて見えないようにする）。入れた後の描画でだけ伸ばす。
  const live = useRef(false);
  const was = useRef({ enabled: o.enabled, badge: showBadge });
  useLayoutEffect(() => {
    if (live.current) {
      if (o.enabled && !was.current.enabled && more.ref.current) growIn(more.ref.current);
      if (showBadge && !was.current.badge && badge.ref.current) fadeIn(badge.ref.current, '--dur-fast');
    }
    was.current = { enabled: o.enabled, badge: showBadge };
    live.current = true;
  }, [o.enabled, showBadge, more.ref, badge.ref]);
  if (!o.available) return null;
  const title = t('settings.opencode.title');
  const b = lastBadge.current;
  return (
    <section className="oc-sec" id="settings-opencode" aria-label={title}>
      <h3 className="h2">
        {props.showTitle !== false && <>{title}<span className="tag-beta">{t('settings.toc.beta')}</span></>}
        {badge.mounted && b && (
          <span className="badge" data-tone={b.tone} ref={badge.ref}>
            {b.tone === 'ok' && <Icon name="check" />}
            {b.tone === 'warn' && <Icon name="alert" />}
            {b.text}
          </span>
        )}
      </h3>
      <SetRow title={t('settings.label.opencodeEnabled')} info={t('settings.opencode.enabledDesc')}
        control={<Switch label={t('settings.label.opencodeEnabled')} checked={o.enabled} onChange={(next) => emit({ type: 'settings.update', patch: { opencodeEnabled: next } })} />} />
      {more.mounted && (
        <div className="oc-more" ref={more.ref}>
          <SetRow title={t('settings.opencode.version.title')} desc={<OpencodeVersion version={o.version} />} control={null} />
          {o.intercept.available && (
            <SetRow title={t('settings.label.opencodeIntercept')} info={t('settings.opencode.intercept.desc')}
              desc={o.intercept.note ? <span className="oc-note" data-tone="info">{o.intercept.note}</span> : undefined}
              control={<Switch label={t('settings.label.opencodeIntercept')} checked={o.intercept.on} onChange={(next) => emit({ type: 'settings.update', patch: { opencodeIntercept: next } })} />} />
          )}
          <SetRow title={t('settings.label.opencodePermissionPreset')} info={t('settings.opencode.permissionPreset.desc')}
            desc={o.permissionPreset.note ? <span className="oc-note" data-tone="info">{o.permissionPreset.note}</span> : undefined}
            control={<Switch label={t('settings.label.opencodePermissionPreset')} checked={o.permissionPreset.on} disabled={o.permissionPreset.byConfig} onChange={(next) => emit({ type: 'settings.update', patch: { opencodePermissionPreset: next } })} />} />
          <SetRow title={t('settings.label.opencodeInjection')} info={t('settings.opencode.injection.desc')}
            desc={o.claudeNote ? <span className="oc-note" data-tone="warn">{o.claudeNote}</span> : undefined}
            below={o.full.length > 0 ? <InjectionFull parts={o.full} /> : undefined}
            control={<Listbox label={t('settings.label.opencodeInjection')} value={o.injection} options={o.injectionOptions} align="end"
              onChange={(v) => emit({ type: 'settings.update', patch: { opencodeInjection: v as OpencodeInjection } })} />} />
          <SetRow title={t('settings.label.opencodeLocalContext')} desc={t('launchPrep.settings.hint')}
            control={<Listbox label={t('settings.label.opencodeLocalContext')} value={String(o.localContext.value)} options={o.localContext.options.map((c) => ({ value: String(c.value), label: c.label }))} align="end"
              onChange={(v) => emit({ type: 'settings.update', patch: { opencodeLocalContext: Number(v) } })} />} />
          <SetRow title={t('settings.label.opencodeIdleUnload')} desc={t('launchPrep.idleUnload.hint')}
            control={<span className="set-row-value">{o.idleUnload.stops.find((s) => s.value === o.idleUnload.value)?.label}</span>}
            below={<StepSlider label={t('settings.label.opencodeIdleUnload')} stops={o.idleUnload.stops} value={o.idleUnload.value}
              onChange={(v) => emit({ type: 'settings.update', patch: { opencodeIdleUnload: v } })} />} />
          {props.providers && <OpencodeProviders p={props.providers} />}
        </div>
      )}
    </section>
  );
}
