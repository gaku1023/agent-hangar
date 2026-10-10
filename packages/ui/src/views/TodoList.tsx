import { useState } from 'react';
import { useEmit } from '../action/chain.tsx';
import type { TodoItemProps } from '../presenters/project.ts';
import { isComposing } from './ime.ts';
import { Icon } from './primitives/Icon.tsx';
import { useT } from './primitives/language.tsx';

/**
 * プロジェクトの TODO。並び替えは持たず、完了した項目も同じ並びに打消し線で残す。
 * 完了の候補は、欄を半分塗りにし、根拠と出したセッションと確定と却下を行の下に常に出す（開かずに判断できるように）。
 * 候補の欄を押したときの扱い（確定にする）は Runtime が決める。View は反転の UiAction を出すだけにする。
 * canAdd が偽なら足す欄を出さない（セッション画面の右欄。
 * 足すのはプロジェクト画面に任せる）。
 */
export function TodoList(props: { projectId: string; todos: TodoItemProps[]; canAdd?: boolean }) {
  const emit = useEmit();
  const t = useT();
  const [text, setText] = useState('');
  const add = () => { if (!text.trim()) return; emit({ type: 'todo.add', projectId: props.projectId, text }); setText(''); };
  return (
    <div className="todos">
      {/* 足す欄があるときは、空であることを別の行で言わない（欄の薄い字が言う）。足す欄の無い場所でだけ書く。 */}
      {props.todos.length === 0 && props.canAdd === false && <div className="faint">{t('projectScreen.todo.empty')}</div>}
      <ul className="todo-list">
        {/* 同じ文言の項目が並ぶことがあるので、読み上げの名前に何件目かを混ぜて一意にする。 */}
        {props.todos.map((todo, i) => {
          const nth = t('projectScreen.todo.nth', { text: todo.text, n: i + 1 });
          const c = todo.candidate;
          return (
            <li key={todo.id} className="todo-item" data-candidate={c ? 'true' : undefined}>
              <div className="todo" data-done={todo.done ? 'true' : undefined}>
                {/* 押すと緑に満ち、チェックの線が描かれる。線の描画は CSS の stroke-dashoffset で動かす。候補の間は半分だけ満ちた印にする。 */}
                <button type="button" role="checkbox" className="todo-check" data-candidate={c ? 'true' : undefined} aria-checked={todo.done}
                  aria-label={c ? t('projectScreen.todo.nthCandidate', { text: todo.text, n: i + 1 }) : nth} aria-describedby={c ? `todo-why-${todo.id}` : undefined}
                  onClick={() => emit({ type: 'todo.toggle', id: todo.id })}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>
                </button>
                <span className="todo-text">{todo.text}</span>
                <button className="btn todo-del" aria-label={t('projectScreen.todo.delete', { name: nth })} onClick={() => emit({ type: 'todo.remove', id: todo.id })}><Icon name="close" /></button>
              </div>
              {c && (
                <div className="todo-cand">
                  <div className="todo-why" id={`todo-why-${todo.id}`}>{c.note}</div>
                  <div className="todo-src">
                    {c.sessionId
                      ? <button type="button" className="todo-src-link" onClick={() => emit({ type: 'session.open', id: c.sessionId! })}>{c.sessionName}</button>
                      : <span>{c.sessionName}</span>}
                    <span className="faint"> · {c.ago}</span>
                  </div>
                  <div className="todo-acts">
                    <button type="button" className="btn btn-primary" aria-label={t('projectScreen.todo.confirm', { name: nth })} onClick={() => emit({ type: 'todo.confirm', id: todo.id })}>{t('projectScreen.todo.confirmButton')}</button>
                    <button type="button" className="btn" aria-label={t('projectScreen.todo.reject', { name: nth })} onClick={() => emit({ type: 'todo.reject', id: todo.id })}>{t('projectScreen.todo.rejectButton')}</button>
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {props.canAdd !== false && <div className="rail-add">
        {/* 変換中の Enter で足すと、確定と同時に書きかけが消える。 */}
        <input id="todo-input" className="input" aria-label={t('projectScreen.todo.addLabel')} placeholder={props.todos.length === 0 ? t('projectScreen.todo.empty') : undefined} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !isComposing(e)) add(); }} />
        <button className="btn" onClick={add}><Icon name="add" />{t('projectScreen.todo.addButton')}</button>
      </div>}
    </div>
  );
}
