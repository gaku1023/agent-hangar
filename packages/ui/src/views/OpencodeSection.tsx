import { useLayoutEffect, useRef } from 'react';
import type { OpencodeInjection } from '@agent-hangar/shared';
import { useEmit } from '../action/chain.tsx';
import type { OpencodeSettingsProps } from '../presenters/settings.ts';
import { Icon } from './primitives/Icon.tsx';
import { useT } from './primitives/language.tsx';
import { Listbox } from './primitives/Listbox.tsx';
import { collapseOut, fadeIn, fadeOut, growIn, motionOn } from './primitives/motionKit.ts';
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
 * コマンドの横取りの行は段 D2 で足す。Windows では段 G1 まで面ごと出さない（available が偽）。どれも選んだ時点で保存する。
 */
export function OpencodeSection(props: { o: OpencodeSettingsProps }) {
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
        {title}
        <span className="tag-beta">{t('settings.toc.beta')}</span>
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
          <SetRow title={t('settings.label.opencodeInjection')} info={t('settings.opencode.injection.desc')}
            desc={o.claudeNote ? <span className="oc-note" data-tone="warn">{o.claudeNote}</span> : undefined}
            control={<Listbox label={t('settings.label.opencodeInjection')} value={o.injection} options={o.injectionOptions} align="end"
              onChange={(v) => emit({ type: 'settings.update', patch: { opencodeInjection: v as OpencodeInjection } })} />} />
        </div>
      )}
    </section>
  );
}
