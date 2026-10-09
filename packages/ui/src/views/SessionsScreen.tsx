import type { SessionsProps } from '../presenters/sessions.ts';
import { PageHeading } from './PageHeading.tsx';
import { SessionList } from './SessionList.tsx';

/** 件数は桁を区切る（タブの件数と同じ書き方）。 */
const fmt = (n: number) => n.toLocaleString('en-US');

/**
 * セッション横断の一覧と検索（★）。
 * 見出しと器だけを持ち、中身はホームとプロジェクトの画面と同じ一覧の部品（SessionList）に任せる。
 * 欄を正とする。トークン（is:paused、since:7d、project:、file:）は欄が読む（パレットの「全文検索」の行も search.query へ来る）。
 */
export function SessionsScreen(props: SessionsProps) {
  return (
    <div className="screen sessions-screen screen-fill">
      <PageHeading title="セッション"><span className="faint num sessions-count">{fmt(props.allCount)} 件</span></PageHeading>
      <SessionList {...props} />
    </div>
  );
}
