/** オン・オフの設定に使うスイッチ。値は持たず、押されたら反転した値を親へ渡す。 */
export function Switch(props: { label: string; checked: boolean; onChange: (next: boolean) => void; disabled?: boolean }) {
  return <button type="button" role="switch" className="switch" aria-label={props.label} aria-checked={props.checked} disabled={props.disabled} onClick={() => props.onChange(!props.checked)} />;
}
