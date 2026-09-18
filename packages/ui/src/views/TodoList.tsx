import { useState } from 'react';
import { useEmit } from '../intent/chain.tsx';
import type { TodoItemProps } from '../presenters/project.ts';
import { isComposing } from './ime.ts';
import { Icon } from './primitives/Icon.tsx';

/** プロジェクトの TODO。並び替えは持たず、完了した項目も同じ並びに打消し線で残す。 */
export function TodoList(props: { projectId: string; todos: TodoItemProps[] }) {
  const emit = useEmit();
  const [text, setText] = useState('');
  const add = () => { if (!text.trim()) return; emit({ type: 'todo.add', projectId: props.projectId, text }); setText(''); };
  return (
    <div className="todos">
      {props.todos.length === 0 && <div className="faint">TODO はまだありません</div>}
      <ul className="todo-list">
        {/* 同じ文言の項目が並ぶことがあるので、読み上げの名前に何件目かを混ぜて一意にする。 */}
        {props.todos.map((t, i) => (
          <li key={t.id} className="todo" data-done={t.done ? 'true' : undefined}>
            <input type="checkbox" checked={t.done} aria-label={`${t.text}（${i + 1} 件目）`} onChange={() => emit({ type: 'todo.toggle', id: t.id })} />
            <span className="todo-text">{t.text}</span>
            <button className="btn todo-del" aria-label={`${t.text}（${i + 1} 件目）を削除`} onClick={() => emit({ type: 'todo.remove', id: t.id })}><Icon name="close" /></button>
          </li>
        ))}
      </ul>
      <div className="rail-add">
        {/* 変換中の Enter で足すと、確定と同時に書きかけが消える。 */}
        <input id="todo-input" className="input" aria-label="TODO を追加" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !isComposing(e)) add(); }} />
        <button className="btn" onClick={add}><Icon name="add" />追加</button>
      </div>
    </div>
  );
}
