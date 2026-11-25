import { useEffect, useState } from 'react';
import { useEmit } from '../action/chain.tsx';
import { SetRow } from './primitives/SetRow.tsx';
import { Stepper } from './primitives/Stepper.tsx';
import { useT } from './primitives/language.tsx';

/** 打つのが止まってから保存するまでの間（ms）。打つ途中の桁（3 から 30 から 300）を送らない。 */
const SAVE_AFTER_MS = 600;

/** 1 つの境目の欄。K 単位で受け、1 から 10000 の整数のときだけ、トークン数（K の 1000 倍）にして保存する。 */
function BoundRow(props: { title: string; unit: string; valueK: number; field: 'contextWarnTokens' | 'contextAlertTokens' }) {
  const emit = useEmit();
  const [text, setText] = useState(String(props.valueK));
  useEffect(() => { setText(String(props.valueK)); }, [props.valueK]);
  useEffect(() => {
    const n = text.trim() === '' ? Number.NaN : Number(text);
    if (!Number.isInteger(n) || n < 1 || n > 10_000 || n === props.valueK) return undefined;
    const id = setTimeout(() => emit({ type: 'settings.update', patch: { [props.field]: n * 1000 } }), SAVE_AFTER_MS);
    return () => clearTimeout(id);
  }, [text, props.valueK, props.field, emit]);
  return <SetRow title={props.title} control={<><Stepper label={props.title} value={text} min={1} max={10_000} step={10} onChange={setText} /><span className="faint">{props.unit}</span></>} />;
}

/** 使用量の節の、context の量の色の境目（黄と赤）。サイドバーの輪と状態の行の label の色が、この 2 つで替わる。 */
export function ContextBounds(props: { warnK: number; alertK: number }) {
  const t = useT();
  return (
    <>
      <BoundRow title={t('settings.context.warn')} unit={t('settings.context.unit')} valueK={props.warnK} field="contextWarnTokens" />
      <BoundRow title={t('settings.context.alert')} unit={t('settings.context.unit')} valueK={props.alertK} field="contextAlertTokens" />
    </>
  );
}
