import { Fragment, useEffect, useId, useState, type KeyboardEvent } from 'react';
import { useEmit } from '../action/chain.tsx';
import type { MoveSessionProps } from '../presenters/moveSession.ts';
import { isComposing } from './ime.ts';
import { Dialog } from './primitives/Dialog.tsx';
import { Icon } from './primitives/Icon.tsx';
import { useT } from './primitives/language.tsx';
import { arrangeSections, highlight, type ListboxOption } from './primitives/listboxModel.ts';
import { SLOT, slot } from './primitives/slot.tsx';

/**
 * セッションを別のプロジェクトへ移す先を選ぶダイアログ（試作の 2A）。
 * 上の欄で絞り込み、一覧から選び、「{project} へ移動」で移す。選ぶまで移すボタンは押せない。
 * 一覧の作りは新しいセッションのダイアログのプロジェクトの選び方と同じで、区切りは「最近」と「すべて」、行頭に状態の点を置く。クイックセッションは絵で見分ける。
 * いまの所属の行は押せず、「現在のプロジェクト」を添える。
 * 動くのは hangar での分類だけで、トランスクリプトと再開するフォルダは元のままであることを、下の注意書きで伝える。
 * 開いたときのフォーカスは検索の欄（Dialog が入力の欄に当てる）。↑ ↓ で行を移り、Enter で選ぶ。押せない行は飛ばす。
 * 選んだ行の上でもう一度 Enter を押すと、移すボタンと同じく移す。行に印が無いときは、選んだ先があれば検索の欄の Enter で移す。
 * 選んだ行が絞り込みで一覧から消えたら、選択を外す。見えない先へ移さないためである。
 */
export function MoveSessionDialog(props: MoveSessionProps) {
  const t = useT();
  const emit = useEmit();
  const uid = useId();
  const listId = `${uid}-list`;
  const optId = (i: number) => `${uid}-opt-${i}`;
  const [query, setQuery] = useState('');
  const [choice, setChoice] = useState<string | null>(null);
  const [active, setActive] = useState(-1);

  const currentTag = t('session.moveDialog.current');
  const options: ListboxOption[] = props.projects.map((p) => ({
    value: p.id, label: p.name, ...(p.path ? { sub: p.path } : {}),
    ...(p.quick ? { icon: 'scratch' as const } : { status: p.status }),
    ...(p.current ? { tag: currentTag } : {}),
  }));
  const current = new Set(props.projects.filter((p) => p.current).map((p) => p.id));
  const recent = new Set(props.recentIds);
  const groups = [
    { title: t('newSession.project.groupRecent'), values: props.recentIds },
    { title: t('newSession.project.groupAll'), values: props.projects.filter((p) => !recent.has(p.id)).map((p) => p.id) },
  ];
  const sections = arrangeSections(options, groups, query);
  const items = sections.flatMap((s) => s.items);
  const pickable = items.filter((i) => !current.has(i.option.value)).map((i) => i.index);
  // 絞り込みで印の行が消えたら、印を外す。
  const shown = pickable.includes(active) ? active : -1;
  useEffect(() => { if (shown !== active) setActive(shown); }, [shown, active]);
  // 絞り込みで選んだ行が消えたら、選択を外す。検索を戻しても選び直さない。
  const chosen = choice !== null && items.some((i) => i.option.value === choice) ? choice : null;
  useEffect(() => { if (chosen !== choice) setChoice(chosen); }, [chosen, choice]);

  const close = () => emit({ type: 'overlay.close' });
  const target = props.projects.find((p) => p.id === chosen && !p.current) ?? null;
  const submit = () => {
    if (!target) return;
    close();
    emit({ type: 'session.move', id: props.sessionId, projectId: target.id });
  };
  const choose = (o: ListboxOption) => { if (!current.has(o.value)) setChoice(o.value); };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (isComposing(e)) return;
    const at = pickable.indexOf(shown);
    switch (e.key) {
      case 'ArrowDown': if (pickable.length) setActive(pickable[at < 0 ? 0 : (at + 1) % pickable.length]!); break;
      case 'ArrowUp': if (pickable.length) setActive(pickable[at <= 0 ? pickable.length - 1 : at - 1]!); break;
      case 'Enter': {
        // 印の行がまだ選んでいない行なら選ぶ。選んだ行の上か、印が無いときは移す（選んだ先が無ければ何もしない）。
        const hit = items.find((i) => i.index === shown);
        if (hit && hit.option.value !== chosen) choose(hit.option);
        else submit();
        break;
      }
      default: return;
    }
    e.preventDefault();
    e.stopPropagation();
  };

  const marks = (text: string) => highlight(text, query).map((s, i) => (s.hit ? <mark key={i}>{s.text}</mark> : <Fragment key={i}>{s.text}</Fragment>));
  const option = ({ option: o, index }: { option: ListboxOption; index: number }) => {
    const off = current.has(o.value);
    return (
      <div key={o.value} id={optId(index)} role="option" aria-selected={o.value === chosen} aria-disabled={off ? 'true' : undefined} aria-label={o.label}
        className="listbox-opt" data-active={index === shown ? 'true' : undefined}
        onMouseMove={() => { if (!off && index !== shown) setActive(index); }} onClick={() => choose(o)}>
        {o.status ? <span className="st-dot" data-status={o.status} aria-hidden="true" /> : o.icon ? <Icon name={o.icon} /> : null}
        <span className="listbox-opt-main">
          <b>{marks(o.label)}</b>
          {o.sub && <small data-kind="path">{marks(o.sub)}</small>}
        </span>
        {o.tag && <span className="listbox-tag">{o.tag}</span>}
        <span className="listbox-check" aria-hidden="true"><Icon name="check" /></span>
      </div>
    );
  };

  return (
    <Dialog
      title={t('session.moveDialog.title')}
      onClose={close}
      closeOnBackdrop={false}
      className="move-dialog"
      footer={<>
        <button type="button" className="btn" onClick={close}>{t('common.button.cancel')}</button>
        <span className="spacer" />
        <button type="button" className="btn btn-primary" disabled={!target} onClick={submit}>{target ? t('session.moveDialog.action', { project: target.name }) : t('session.moveDialog.actionNone')}</button>
      </>}
    >
      <div className="muted">{slot(t('session.moveDialog.lead', { name: SLOT }), <b>{props.name}</b>)}</div>
      <div className="move-pick">
        <div className="listbox-search">
          <Icon name="search" />
          <input role="combobox" aria-label={t('session.moveDialog.search')} placeholder={t('session.moveDialog.search')} aria-expanded="true" aria-controls={listId} aria-autocomplete="list"
            aria-activedescendant={shown >= 0 ? optId(shown) : undefined} value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={onKey} />
        </div>
        <div id={listId} role="listbox" aria-label={t('session.moveDialog.listLabel')} className="listbox-body">
          <div className="listbox-rows">
            {sections.map((s, si) => (s.title === null
              ? <Fragment key={`s${si}`}>{s.items.map(option)}</Fragment>
              : (
                <div key={`s${si}`} role="group" aria-labelledby={`${uid}-g${si}`}>
                  <div id={`${uid}-g${si}`} className="listbox-group-title">{s.title}</div>
                  {s.items.map(option)}
                </div>
              )))}
            {!items.length && <div className="listbox-empty">{t('common.empty.noMatch')}</div>}
          </div>
        </div>
      </div>
      <div className="faint">{t('session.moveDialog.note', { cwd: props.cwd })}</div>
    </Dialog>
  );
}
