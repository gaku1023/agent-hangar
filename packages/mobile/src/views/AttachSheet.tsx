import { useId, type ChangeEvent, type ReactNode } from 'react';
import { BottomSheet } from './BottomSheet.tsx';

type Props = {
  open: boolean;
  onClose: () => void;
  /** 選んだ画像。1 枚も選ばなかったときは呼ばない。 */
  onFiles: (files: File[]) => void;
};

/**
 * 「＋」で開く、写真とカメラのシート。
 * 選ぶ口はファイルの input そのもの（label で包む）。iOS の Safari は、利用者のタップの中でしか選ぶ画面を開かないためである。
 */
export function AttachSheet({ open, onClose, onFiles }: Props): ReactNode {
  const libId = useId();
  const camId = useId();
  const picked = (e: ChangeEvent<HTMLInputElement>): void => {
    const files = Array.from(e.target.files ?? []);
    // 同じ写真をもう一度選んでも change が来るように空にする。
    e.target.value = '';
    if (files.length === 0) return;
    onFiles(files);
    onClose();
  };
  return (
    <BottomSheet open={open} title="画像を添付" closeText="キャンセル" onClose={onClose}>
      <div className="cm-attach">
        <label className="cm-arow" htmlFor={libId}>
          <i aria-hidden="true">🖼</i>
          <span>写真ライブラリ</span>
          <small>ここから選ぶ</small>
          <input id={libId} className="vh" type="file" accept="image/*" multiple onChange={picked} />
        </label>
        <label className="cm-arow" htmlFor={camId}>
          <i aria-hidden="true">📷</i>
          <span>写真を撮る</span>
          <input id={camId} className="vh" type="file" accept="image/*" capture="environment" onChange={picked} />
        </label>
        <p className="cm-anote">画像は 1 枚 5 MB まで、4 枚までです。長い辺を 2048 px に縮めてから送信します。</p>
      </div>
    </BottomSheet>
  );
}
