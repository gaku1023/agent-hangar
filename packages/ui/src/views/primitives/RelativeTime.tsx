export function RelativeTime(props: { label: string; abs: string }) {
  return <time className="mono muted" title={props.abs}>{props.label}</time>;
}
