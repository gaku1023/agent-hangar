import { useLayoutEffect, useRef } from 'react';
import type { CodexInjection } from '@agent-hangar/shared';
import { useEmit } from '../action/chain.tsx';
import type { CodexSettingsProps } from '../presenters/settings.ts';
import { InvestigateButton } from './InvestigateButton.tsx';
import { Icon } from './primitives/Icon.tsx';
import { useT } from './primitives/language.tsx';
import { Listbox } from './primitives/Listbox.tsx';
import { collapseOut, fadeIn, fadeOut, growIn, motionOn } from './primitives/motionKit.ts';
import { SetRow } from './primitives/SetRow.tsx';
import { ShareRows } from './ShareRows.tsx';
import { Switch } from './primitives/Switch.tsx';
import { usePresence } from './primitives/usePresence.ts';

/** 見出しの右に「エージェントで調査…」を置く版の区分。その場で直す口が無く、入れ直すか上げるか PATH を直すもの。 */
const INVESTIGATE_KINDS: ReadonlySet<string> = new Set(['missing']);

/** 版の行の本文。手元の版と確かめた範囲を並べ、範囲の外や見つからないときはその下に文を、ログインしていないときはさらにその下に注記を添える。届く前は「読み込み中…」。 */
function CodexVersion(props: { version: CodexSettingsProps['version'] }) {
  const t = useT();
  const v = props.version;
  if (v === null) return <span>{t('settings.common.loading')}</span>;
  return (
    <>
      {v.kind !== 'missing' && (
        <span className="oc-vers">
          {v.installed !== null && <>{t('settings.codex.version.installed')} <code>{v.installed}</code>{' · '}</>}
          {t('settings.codex.version.verified')} <code>{v.verified}</code>
        </span>
      )}
      {v.note && <span className="oc-note" data-tone={v.kind === 'unverified' || v.kind === 'unknown' ? 'info' : 'warn'}>{v.note}</span>}
      {v.login && <span className="oc-note" data-tone="warn">{v.login}</span>}
    </>
  );
}

/**
 * 設定の「連携 › Codex」（ベータ、C4 の案 A）。opencode の面の下に、同じ形の別の白い面として置く。
 * 「有効にする」の行だけを常に出し、入れたときだけバージョン、コマンドの横取り（macOS と Linux だけ）、システムプロンプトへの追記の行を growIn で伸ばして入れる（切ると collapseOut で畳んでから外す）。
 * 見出しの右端の札（検証済み、未検証のバージョン、見つかりません）も入のときだけ出し、fadeIn と fadeOut で出入りさせる。
 * 切のままでも、この「有効にする」の 1 行は出す（入口そのものなので、Codex を有効にするまで出さない決まりの例外）。
 * どれも選んだ時点で設定を保存するだけで、シェルの包みと追記の中身は別の段で入る。
 */
export function CodexSection(props: { o: CodexSettingsProps; /** 偽なら見出しの名前とベータの札を出さない（設定の節の見出しがすでに言うとき）。既定は真。 */ showTitle?: boolean }) {
  const t = useT();
  const emit = useEmit();
  const o = props.o;
  const more = usePresence<HTMLDivElement>(o.enabled, (el) => (motionOn(el) ? collapseOut(el) : null));
  const showBadge = o.enabled && o.badge !== null;
  const badge = usePresence<HTMLSpanElement>(showBadge, (el) => (motionOn(el) ? fadeOut(el) : null));
  const lastBadge = useRef(o.badge);
  if (o.badge) lastBadge.current = o.badge;
  // 最初の描画では動かさない。入れた後の描画でだけ伸ばす。
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
  const title = t('settings.codex.title');
  const b = lastBadge.current;
  return (
    <section className="oc-sec" id="settings-codex" aria-label={title}>
      <h3 className="h2">
        {props.showTitle !== false && <>{title}<span className="tag-beta">{t('settings.toc.beta')}</span></>}
        {badge.mounted && b && (
          <span className="badge" data-tone={b.tone} ref={badge.ref}>
            {b.tone === 'ok' && <Icon name="check" />}
            {b.tone === 'warn' && <Icon name="alert" />}
            {b.text}
          </span>
        )}
        {o.enabled && o.version && INVESTIGATE_KINDS.has(o.version.kind) && o.version.note && <InvestigateButton ctx={{ op: 'agentVersion', agent: 'codex', message: o.version.note }} />}
      </h3>
      <SetRow title={t('settings.label.codexEnabled')} info={t('settings.codex.enabledDesc')}
        control={<Switch label={t('settings.label.codexEnabled')} checked={o.enabled} onChange={(next) => emit({ type: 'settings.update', patch: { codexEnabled: next } })} />} />
      {more.mounted && (
        <div className="oc-more" ref={more.ref}>
          <SetRow title={t('settings.codex.version.title')} desc={<CodexVersion version={o.version} />} control={null} />
          {o.intercept.available && (
            <SetRow title={t('settings.label.codexIntercept')} info={t('settings.codex.intercept.desc')}
              desc={o.intercept.note ? <span className="oc-note" data-tone="info">{o.intercept.note}</span> : undefined}
              control={<Switch label={t('settings.label.codexIntercept')} checked={o.intercept.on} onChange={(next) => emit({ type: 'settings.update', patch: { codexIntercept: next } })} />} />
          )}
          <SetRow title={t('settings.label.codexInjection')} info={t('settings.codex.injection.desc')}
            control={<Listbox label={t('settings.label.codexInjection')} value={o.injection} options={o.injectionOptions} align="end"
              onChange={(v) => emit({ type: 'settings.update', patch: { codexInjection: v as CodexInjection } })} />} />
          <ShareRows o={o.share} />
        </div>
      )}
    </section>
  );
}
