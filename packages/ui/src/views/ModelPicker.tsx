import { isModelName, MODEL_CHOICES } from '@agent-hangar/shared';
import { useT } from './primitives/language.tsx';
import { Listbox } from './primitives/Listbox.tsx';
import type { ListboxAction, ListboxOption } from './primitives/listboxModel.ts';

/** 「Claude Code の既定」の行の値。モデルの名前と重ならない。 */
const DEFAULT_VALUE = '';

/**
 * モデルを選ぶ一覧（設定の既定のモデルと、要約に使う Claude のモデル）。
 * 一覧はよく使う別名で、一覧に無い名前は検索の欄に打って「『名前』を使う」で選ぶ。名前の形は isModelName で確かめる。
 * withDefault が真なら先頭に「Claude Code の既定」を置き、選ぶと null を渡す。
 * 選んだ時点で onChange を呼ぶ（保存は呼び手が決める）。
 */
export function ModelPicker(props: { label: string; value: string | null; withDefault?: boolean; onChange: (model: string | null) => void }) {
  const t = useT();
  const value = props.value ?? DEFAULT_VALUE;
  const names: string[] = [...MODEL_CHOICES];
  // 保存済みの名前が一覧に無くても、顔と一覧から消さない。
  if (value !== DEFAULT_VALUE && !names.includes(value)) names.unshift(value);
  const options: ListboxOption[] = [
    ...(props.withDefault ? [{ value: DEFAULT_VALUE, label: t('settings.integrations.inject.model.default') }] : []),
    ...names.map((m) => ({ value: m, label: m })),
  ];
  const actions = (q: string): ListboxAction[] => {
    const name = q.trim();
    return isModelName(name) && !names.includes(name) ? [{ value: name, label: t('settings.integrations.inject.model.use', { name }), icon: 'add' }] : [];
  };
  return (
    <Listbox label={props.label} value={value} options={options} align="end" minWidth={220}
      searchPlaceholder={t('settings.integrations.inject.model.search')}
      onChange={(v) => props.onChange(v === DEFAULT_VALUE ? null : v)}
      actions={actions} onAction={(_v, q) => props.onChange(q.trim())} />
  );
}
