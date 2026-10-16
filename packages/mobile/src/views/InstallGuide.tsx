import type { ReactNode } from 'react';
import { remaining, useNow } from '../countdown.ts';

type Props = {
  /** 開いた QR の期限（ms）。QR から開いたのでなければ null。 */
  expiresAt: number | null;
  /** 案内を閉じて、この Safari で接続の画面へ進む。 */
  onContinue: () => void;
};

/**
 * 入口の案内（A1）。iPhone と iPad の Safari で、ホーム画面のアプリでなく、未接続のときに先に出す。
 * Safari で接続しても、ホーム画面のアプリは保存場所が別で引き継がれない。
 * 先にホーム画面に追加して、そこから開いて接続するよう案内する。
 */
export function InstallGuide({ expiresAt, onContinue }: Props): ReactNode {
  const now = useNow(1000);
  const left = expiresAt === null ? null : expiresAt - now;
  return (
    <main className="join">
      <div className="step m-fade">
        <span className="ctx">Safari で開いている</span>
        <div className="p-logo">
          <i aria-hidden="true" />
          hangar
        </div>
        <h1 className="p-h">先にホーム画面に追加して、そこから開いてください</h1>
        <p className="p-t">いま Safari で接続しても、ホーム画面のアプリには引き継がれません（保存場所が別です）。</p>
        <ol className="steps3">
          <li>
            <i aria-hidden="true">1</i>
            <div>
              <b>共有ボタンを押す</b>
              <span>画面下の □↑ をタップ</span>
            </div>
          </li>
          <li>
            <i aria-hidden="true">2</i>
            <div>
              <b>「ホーム画面に追加」を選ぶ</b>
              <span>一覧を下へ動かすと出ます</span>
            </div>
          </li>
          <li>
            <i aria-hidden="true">3</i>
            <div>
              <b>ホーム画面の hangar を開く</b>
              <span>この Safari の画面は閉じて構いません</span>
            </div>
          </li>
        </ol>
        {left !== null &&
          (left > 0 ? (
            <p className="strip info">
              QR はあと <b className="cd">{remaining(left)}</b> 有効です。ホーム画面に追加しても、そのまま使えます。
            </p>
          ) : (
            <p className="strip warn">QR の期限が切れました。ホーム画面のアプリを開いたら、PC で QR を出し直してください。</p>
          ))}
        <div className="p-spacer" />
        <button type="button" className="lnk" onClick={onContinue}>
          このまま Safari で使う
        </button>
      </div>
    </main>
  );
}
