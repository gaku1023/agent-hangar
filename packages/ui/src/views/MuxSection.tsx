import { useId } from 'react';
import { useEmit } from '../action/chain.tsx';
import type { MuxStatus } from '../presenters/readiness.ts';
import { CommandLine } from './primitives/CommandLine.tsx';
import { Icon } from './primitives/Icon.tsx';
import { InfoTip } from './primitives/InfoTip.tsx';
import { useT } from './primitives/language.tsx';

/**
 * 設定のツールの節の先頭に置く、psmux（Windows）か tmux の状態（段 6 の B3）。
 * 見出しの札でインストール済みか未インストールかを出す（連携の節の札と同じ形）。
 * 済んでいれば版とパスを、無ければ入れるコマンドを添える。
 * 再確認は、入れたあとにその場で探し直すボタンで、帯と始める前の案内と同じ操作（mux.recheck）である。
 */
export function MuxSection(props: { mux: MuxStatus }) {
  const emit = useEmit();
  const t = useT();
  const m = props.mux;
  const id = useId();
  const old = m.installed ? m.outdated : null;
  return (
    <section aria-labelledby={id}>
      <h3 className="h2">
        <span id={id}>{m.name}</span>
        <InfoTip label={m.name}>{t(m.windows ? 'mux.desc.windows' : 'mux.desc.other')}</InfoTip>
        <span className="badge" data-tone={m.installed && !old ? 'ok' : 'warn'}><Icon name={m.installed && !old ? 'check' : 'alert'} />{old ? t('mux.badge.outdated') : m.installed ? t('mux.badge.installed') : t('mux.badge.missing')}</span>
      </h3>
      {m.installed && m.version && <div className="faint">{old ? t('mux.info.versionNeed', { version: m.version, min: old.min }) : t('mux.info.version', { version: m.version })}</div>}
      {m.installed && m.path && <div className="faint mono">{m.path}</div>}
      {/* 古い psmux（issue #245）。上げると psmux の中のセッションが全部止まり、hangar の端末からは打てないので、その 2 点を先に言う。 */}
      {old && (
        <>
          <div style={{ marginTop: 8 }}>{t('mux.outdated.lead', { min: old.min })}</div>
          <ul className="mux-notes">
            <li>{t('mux.outdated.stop')}</li>
            <li>{t('mux.outdated.outside')}</li>
          </ul>
          <CommandLine command={old.command} />
          <div className="faint" style={{ marginTop: 4 }}>{t('mux.outdated.after', { min: old.min })}</div>
        </>
      )}
      {!m.installed && (
        <>
          <div className="faint" style={{ marginTop: 8 }}>{t(m.windows ? 'mux.run.windows' : 'mux.run.other')}</div>
          <CommandLine command={m.command} />
          {m.stillMissing && <div className="faint" role="status" style={{ marginTop: 4 }}>{t('mux.status.stillMissing', { name: m.name })}</div>}
        </>
      )}
      <div style={{ marginTop: 8 }}>
        <button type="button" className="btn" disabled={m.checking} onClick={() => emit({ type: 'mux.recheck' })}>{m.checking ? t('mux.action.checking') : t('mux.action.recheck')}</button>
      </div>
    </section>
  );
}
