import { useState } from 'react';
import { useEmit } from '../intent/chain.tsx';
import type { TodoItemProps } from '../presenters/project.ts';
import { isComposing } from './ime.ts';
import { Icon } from './primitives/Icon.tsx';

/**
 * プロジェクトの TODO。並び替えは持たず、完了した項目も同じ並びに打消し線で残す。
 * 完了の候補は、欄を半分塗りにし、根拠と出したセッションと確定と却下を行の下に常に出す（開かずに判断できるように）。
 * 候補の欄を押したときの扱い（確定にする）は Runtime が決める。View は反転の Intent を出すだけにする。
 * canAdd が偽なら足す欄を出さない（セッション画面の右欄。
 * 足すのはプロジェクト画面に任せる）。
 */
export function TodoList(props: { projectId: string; todos: TodoItemProps[]; canAdd?: boolean }) {
  const emit = useEmit();
  const [text, setText] = useState('');
  const add = () => { if (!text.trim()) return; emit({ type: 'todo.add', projectId: props.projectId, text }); setText(''); };
  return (
    <div className="todos">
      {/* 足す欄があるときは、空であることを別の行で言わない（欄の薄い字が言う）。足す欄の無い場所でだけ書く。 */}
      {props.todos.length === 0 && props.canAdd === false && <div className="faint">TODO はまだありません</div>}
      <ul className="todo-list">
        {/* 同じ文言の項目が並ぶことがあるので、読み上げの名前に何件目かを混ぜて一意にする。 */}
        {props.todos.map((t, i) => {
          const nth = `${t.text}（${i + 1} 件目）`;
          const c = t.candidate;
          return (
            <li key={t.id} className="todo-item" data-candidate={c ? 'true' : undefined}>
              <div className="todo" data-done={t.done ? 'true' : undefined}>
                {/* 押すと緑に満ち、チェックの線が描かれる。線の描画は CSS の stroke-dashoffset で動かす。候補の間は半分だけ満ちた印にする。 */}
                <button type="button" role="checkbox" className="todo-check" data-candidate={c ? 'true' : undefined} aria-checked={t.done}
                  aria-label={c ? `${t.text}（${i + 1} 件目、完了の候補）` : nth} aria-describedby={c ? `todo-why-${t.id}` : undefined}
                  onClick={() => emit({ type: 'todo.toggle', id: t.id })}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>
                </button>
                <span className="todo-text">{t.text}</span>
                <button className="btn todo-del" aria-label={`${nth}を削除`} onClick={() => emit({ type: 'todo.remove', id: t.id })}><Icon name="close" /></button>
              </div>
              {c && (
                <div className="todo-cand">
                  <div className="todo-why" id={`todo-why-${t.id}`}>{c.note}</div>
                  <div className="todo-src">
                    {c.sessionId
                      ? <button type="button" className="todo-src-link" onClick={() => emit({ type: 'session.open', id: c.sessionId! })}>{c.sessionName}</button>
                      : <span>{c.sessionName}</span>}
                    <span className="faint"> · {c.ago}</span>
                  </div>
                  <div className="todo-acts">
                    <button type="button" className="btn btn-primary" aria-label={`${nth}を確定`} onClick={() => emit({ type: 'todo.confirm', id: t.id })}>確定</button>
                    <button type="button" className="btn" aria-label={`${nth}を却下`} onClick={() => emit({ type: 'todo.reject', id: t.id })}>却下</button>
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {props.canAdd !== false && <div className="rail-add">
        {/* 変換中の Enter で足すと、確定と同時に書きかけが消える。 */}
        <input id="todo-input" className="input" aria-label="TODO を追加" placeholder={props.todos.length === 0 ? 'TODO はまだありません' : undefined} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !isComposing(e)) add(); }} />
        <button className="btn" onClick={add}><Icon name="add" />追加</button>
      </div>}
    </div>
  );
}
