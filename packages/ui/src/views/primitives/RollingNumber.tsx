import { useT } from './language.tsx';
import { RollingText } from './RollingText.tsx';

/**
 * 数を回す。桁ごとには分けない。読めない値は「未取得」と書く。
 * 回し方は RollingText が持つ。
 */
export function RollingNumber(props: { value: number | null; suffix?: string }) {
  const t = useT();
  return <RollingText text={props.value === null ? t('primitives.rollingNumber.unavailable') : `${props.value}${props.suffix ?? ''}`} />;
}
