import { useEffect, useRef } from 'react';
import { useEmit } from '../action/chain.tsx';
import { Icon } from './primitives/Icon.tsx';
import { useT } from './primitives/language.tsx';

/**
 * 新しいフォルダを作る場所の欄（作成場所が空のとき。2026-10-13）。
 * 設定の作成場所は任意なので、決めていなければ作るたびに場所を選ぶ。デスクトップでは「選ぶ…」で Finder を開き、ブラウザではパスを打つ。
 * 新しいプロジェクト、新しいセッションの新しいフォルダ、クイックセッションの昇格が使う。
 * Finder の結果は、この欄の「選ぶ…」を押した後に届いたものだけを入れる（同じダイアログのほかの「選ぶ…」の結果を当てない）。
 */
export function ParentField(props: { value: string; onChange: (v: string) => void; desktop: boolean; picked: { path: string; n: number } | null }) {
  const emit = useEmit();
  const t = useT();
  const seen = useRef(props.picked?.n ?? 0);
  const waiting = useRef(false);
  useEffect(() => {
    const p = props.picked;
    if (!p || p.n <= seen.current) return;
    seen.current = p.n;
    if (!waiting.current) return;
    waiting.current = false;
    props.onChange(p.path);
  }, [props.picked?.n]);   // eslint-disable-line react-hooks/exhaustive-deps
  const label = t('newProject.parent.label');
  return (
    <div className="field">{label}
      <div className="field-row">
        <input className="input mono" style={{ flex: 1 }} aria-label={label} placeholder={t('newProject.parent.placeholder')} value={props.value} onChange={(e) => props.onChange(e.target.value)} />
        {props.desktop && (
          <button type="button" className="btn" aria-label={t('home.band.actionFor', { action: t('newProject.parent.pick'), name: label })} onClick={() => { waiting.current = true; emit({ type: 'folder.pick' }); }}>
            <Icon name="folderOpen" />{t('newProject.parent.pick')}
          </button>
        )}
      </div>
    </div>
  );
}

/** 作る場所を選んでいるか。作成場所が決まっていれば要らない。 */
export function parentReady(workspaceRoot: string | null, parent: string): boolean {
  return workspaceRoot !== '' || parent.trim() !== '';
}
