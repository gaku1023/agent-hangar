import { useState } from 'react';
import type { ConfigKindKey, ConfigKindMode, SettingsDto } from '@agent-hangar/shared';
import { useEmit } from '../action/chain.tsx';
import type { KindBundleProps, KindRowProps, KindsProps } from '../presenters/configKinds.ts';
import { Reveal } from './ConfigSyncParts.tsx';
import { KindModeSwitch } from './ConfigTriSwitch.tsx';
import { Icon } from './primitives/Icon.tsx';
import { useT } from './primitives/language.tsx';

/**
 * 設定の同期の種類ごとの行（試作の C 性質ごと）。
 * 会話の本文を先頭に、指示、スキルとコマンド、記憶を左の段、設定、自動で走るコードを右の段に並べる。
 * 束の見出しにも切り替えを置き、中が揃っていなければつまみを消す。自動で走るコードの束は色を付ける。
 * 保存は settings の configKinds に、変えた鍵だけを送る。
 * 自動で走るコード（束、または種類）を自動にするときだけ、行の下に 1 文の帯を開き、「自動にする」を押すまで保存しない。
 */
export function ConfigKindsList(props: { kinds: KindsProps }) {
  const emit = useEmit();
  const t = useT();
  // 帯を開いている先。種類の鍵か、束の id。保存する鍵の組と、帯の文に入れる名前を持つ。
  const [pending, setPending] = useState<{ at: string; keys: ConfigKindKey[]; name: string } | null>(null);
  const [linkOpen, setLinkOpen] = useState<string | null>(null);

  const save = (keys: readonly ConfigKindKey[], mode: ConfigKindMode) => {
    setPending(null);
    emit({ type: 'settings.update', patch: { configKinds: Object.fromEntries(keys.map((k) => [k, mode])) } as unknown as Partial<SettingsDto> });
  };
  const change = (at: string, keys: ConfigKindKey[], name: string, current: ConfigKindMode | 'mixed', exec: boolean, mode: ConfigKindMode) => {
    if (exec && mode === 'auto' && current !== 'auto') { setPending({ at, keys, name }); return; }
    save(keys, mode);
  };

  const strip = (at: string) => (
    <Reveal open={pending?.at === at}>
      <div className="cfg-strip" data-tone="danger" role="group" aria-label={t('configKindsUi.exec.ok')}>
        <Icon name="alert" />
        <span>{t('configKindsUi.exec.warn', { name: pending?.name ?? '' })}</span>
        <span className="spacer" />
        <span className="cfg-strip-acts">
          <button type="button" className="btn btn-sm" onClick={() => setPending(null)}>{t('configKindsUi.exec.cancel')}</button>
          <button type="button" className="btn btn-sm btn-primary" onClick={() => { if (pending) save(pending.keys, 'auto'); }}>{t('configKindsUi.exec.ok')}</button>
        </span>
      </div>
    </Reveal>
  );

  const row = (r: KindRowProps) => (
    <div key={r.key} className="kr-wrap">
      <div className="kr" data-s={r.mode} data-k={r.key}>
        <span className="kr-t">
          <span className="kr-name">{r.name}</span>
          {r.count !== null && <span className="kr-n">{r.count.toLocaleString()}</span>}
          {r.links.length > 0 && (
            <button type="button" className="kr-link" aria-expanded={linkOpen === r.key} aria-label={t('configKindsUi.links.label', { n: r.links.length })} onClick={() => setLinkOpen(linkOpen === r.key ? null : r.key)}>
              <Icon name="unlink" />{r.links.length}
            </button>
          )}
        </span>
        <KindModeSwitch label={r.name} value={r.mode} two={r.two} onChange={(m) => change(r.key, [r.key], r.name, r.mode, r.exec, m)} />
      </div>
      <Reveal open={linkOpen === r.key && r.links.length > 0}>
        <div className="kr-links">{r.links.map((n) => <code key={n}>{n}</code>)}</div>
      </Reveal>
      {r.exec && strip(r.key)}
    </div>
  );

  const bundle = (b: KindBundleProps) => (
    <div key={b.id} className="kgroup" data-exec={b.exec ? '' : undefined} data-bundle={b.id}>
      {b.title !== null && (
        <div className="kh">
          {b.icon && <Icon name={b.icon} />}
          <span>{b.title}</span>
          {b.mode !== null && <KindModeSwitch label={b.title} value={b.mode} onChange={(m) => change(b.id, b.rows.map((r) => r.key), b.title ?? '', b.mode!, b.exec, m)} />}
        </div>
      )}
      {b.exec && strip(b.id)}
      {b.rows.map(row)}
    </div>
  );

  return (
    <div className="klist">
      <div className="kcol">{props.kinds.left.map(bundle)}</div>
      <div className="kcol">{props.kinds.right.map(bundle)}</div>
    </div>
  );
}
