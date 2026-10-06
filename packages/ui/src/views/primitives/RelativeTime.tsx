export function RelativeTime(props: { label: string; abs: string }) {
  return <time className="num muted" title={props.abs}>{props.label}</time>;
}
