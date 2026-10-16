import qrcode from 'qrcode-generator';
import { useMemo } from 'react';

/**
 * QR コード（qrcode-generator の升目を、React の svg の path にしたもの）。
 * 文字列の HTML を差し込まない（dangerouslySetInnerHTML を使わない）。升目は 1 単位の正方形を 1 本の path に並べる。
 * 誤り訂正は M。周りの白い余白は呼び手の箱（padding）が持つ。
 * 中身は呼び手が渡した文字列だけで、ここではどこにも送らず、残さない。
 */
export function QrCode(props: { text: string; size: number; label: string; fallback: string }) {
  const grid = useMemo(() => {
    const q = qrcode(0, 'M');
    q.addData(props.text, 'Byte');
    // 版 40 に収まらない長さは make が投げる。投げたら図を描かず、fallback の文を出す（呼び手は文字列のコピーを残す）。
    try { q.make(); } catch { return null; }
    const count = q.getModuleCount();
    let path = '';
    for (let r = 0; r < count; r++) {
      for (let c = 0; c < count; c++) if (q.isDark(r, c)) path += `M${c} ${r}h1v1h-1z`;
    }
    return { n: count, d: path };
  }, [props.text]);
  if (!grid) return <div className="qr-fallback" role="note" style={{ width: props.size }}>{props.fallback}</div>;
  const { n, d } = grid;
  return (
    <svg className="qr-code" role="img" aria-label={props.label} width={props.size} height={props.size} viewBox={`0 0 ${n} ${n}`} shapeRendering="crispEdges">
      <path d={d} fill="currentColor" />
    </svg>
  );
}
