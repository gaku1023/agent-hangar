import type { InjectionPart } from '../presenters/injection.ts';
import { Icon } from './primitives/Icon.tsx';
import { useT } from './primitives/language.tsx';

/**
 * 足す指示の全文の畳み（「追加する指示の全文を表示」）。
 * Claude の「システムプロンプトの追記」の行（InjectionSettings）と、opencode の「システムプロンプトへの追記」の行（OpencodeSection）で同じ形と動きにする。
 * 段ごとに名前を添え、差し込む値の印は破線の枠で描き、切った段は打ち消し線で残す。
 */
export function InjectionFull(props: { parts: InjectionPart[] }) {
  const t = useT();
  return (
    <details className="cp-more">
      <summary><Icon name="chevron" />{t('settings.integrations.inject.full')}</summary>
      <div className="inject-full">
        {props.parts.map((part) => (
          <div key={part.label} className="inject-part">
            <span className="inject-part-k">{part.label}{part.mark && <span className="inject-mark">{part.mark}</span>}</span>
            <span className={part.off ? 'inject-off' : undefined}>
              {part.pieces.map((p, n) => (p.kind === 'token' ? <span key={n} className="inject-token">{p.text}</span> : <span key={n}>{p.text}</span>))}
            </span>
          </div>
        ))}
      </div>
    </details>
  );
}
