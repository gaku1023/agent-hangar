//! 最初の窓を、モニタの作業域（タスクバーを除いた範囲）に収める。
//! 窓の大きさは tauri.conf.json の論理の大きさ（1400×900）で決まり、位置は OS が決める。
//! 1920×1080 の Windows では、外形 1416×939 の窓が y=141 に出て、下の端がタスクバーに隠れた。
//! ここには OS を呼ばない純関数だけを置き、どの OS の試験でも同じ答えになるようにする。
//! 呼ぶのは lib.rs の `fit_main_window` で、macOS では呼ばない（macOS の振る舞いは変えない）。

/// 画面の上の長方形。単位は物理の px で、窓の外形（枠と影を含む）と作業域の両方に使う。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub w: u32,
    pub h: u32,
}

/// 1 つの軸（横か縦）を収める。
/// 長すぎれば作業域の長さまで縮める。
/// はみ出していれば、作業域の中ほどへ寄せる。
/// 収まっていれば、位置も長さも変えない。
fn fit_axis(pos: i32, len: u32, work_pos: i32, work_len: u32) -> (i32, u32) {
    let len2 = len.min(work_len);
    let end = i64::from(pos) + i64::from(len2);
    let work_end = i64::from(work_pos) + i64::from(work_len);
    if len2 == len && pos >= work_pos && end <= work_end {
        return (pos, len);
    }
    let pos2 = i64::from(work_pos) + i64::from((work_len - len2) / 2);
    (pos2 as i32, len2)
}

/// 窓の外形を作業域に収めた外形を返す。
/// もう収まっていれば None を返し、呼び手は窓を動かさない。
/// 作業域の幅か高さが 0（モニタを読めなかった）なら、何もしない。
pub fn fit(window: Rect, work: Rect) -> Option<Rect> {
    if work.w == 0 || work.h == 0 {
        return None;
    }
    let (x, w) = fit_axis(window.x, window.w, work.x, work.w);
    let (y, h) = fit_axis(window.y, window.h, work.y, work.h);
    let fitted = Rect { x, y, w, h };
    (fitted != window).then_some(fitted)
}

/// 収めた外形に合う、中身（webview）の大きさ。
/// 窓の大きさは中身の大きさで指定するので、今の外形と中身の差（枠と見出しの帯）を引く。
pub fn inner_size(fitted: Rect, outer: (u32, u32), inner: (u32, u32)) -> (u32, u32) {
    let frame_w = outer.0.saturating_sub(inner.0);
    let frame_h = outer.1.saturating_sub(inner.1);
    (
        fitted.w.saturating_sub(frame_w),
        fitted.h.saturating_sub(frame_h),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn r(x: i32, y: i32, w: u32, h: u32) -> Rect {
        Rect { x, y, w, h }
    }

    /// 1920×1080 で、下に 48px のタスクバーがある作業域。
    const WORK_1080: Rect = Rect {
        x: 0,
        y: 0,
        w: 1920,
        h: 1032,
    };

    // 実機で見た窓（外形 1416×939、y=141）は下の端がタスクバーに隠れた。縦だけを作業域の中ほどへ寄せる。
    #[test]
    fn the_window_seen_on_a_1080p_screen_moves_up_into_the_work_area() {
        let got = fit(r(252, 141, 1416, 939), WORK_1080).unwrap();
        assert_eq!(got, r(252, 46, 1416, 939));
        assert!(got.y + got.h as i32 <= 1032);
    }

    #[test]
    fn a_window_that_already_fits_is_left_alone() {
        assert_eq!(fit(r(100, 50, 1416, 939), WORK_1080), None);
        assert_eq!(fit(r(0, 0, 1920, 1032), WORK_1080), None);
    }

    // 倍率 125% の 1080p では、1400×900 の論理の大きさが作業域より高くなる。高さを作業域まで縮め、上の端に付ける。
    #[test]
    fn a_window_taller_than_the_work_area_is_shrunk_to_it() {
        let got = fit(r(80, 60, 1766, 1164), WORK_1080).unwrap();
        assert_eq!(got, r(80, 0, 1766, 1032));
    }

    #[test]
    fn a_window_wider_and_taller_than_the_work_area_fills_it() {
        assert_eq!(fit(r(-10, -10, 2600, 1500), WORK_1080), Some(WORK_1080));
    }

    // 作業域の左上は 0 とは限らない（左や上のタスクバー、2 枚目のモニタ）。
    #[test]
    fn the_work_area_may_start_away_from_the_origin() {
        let work = r(1920, 40, 2560, 1400);
        assert_eq!(
            fit(r(1900, 0, 1416, 939), work),
            Some(r(
                1920 + (2560 - 1416) / 2,
                40 + (1400 - 939) / 2,
                1416,
                939
            ))
        );
        // 左や上のはみ出しも同じく寄せる。
        let left_bar = r(48, 0, 1872, 1080);
        assert_eq!(
            fit(r(10, 70, 1416, 939), left_bar),
            Some(r(48 + (1872 - 1416) / 2, 70, 1416, 939))
        );
    }

    #[test]
    fn a_work_area_without_size_changes_nothing() {
        assert_eq!(fit(r(0, 500, 1416, 939), r(0, 0, 0, 0)), None);
        assert_eq!(fit(r(0, 500, 1416, 939), r(0, 0, 1920, 0)), None);
    }

    // 窓は中身の大きさで指定する。枠と見出しの帯の分を引く。
    #[test]
    fn the_inner_size_keeps_the_frame_out_of_the_fitted_outline() {
        let fitted = r(80, 0, 1766, 1032);
        assert_eq!(inner_size(fitted, (1766, 1164), (1750, 1125)), (1750, 993));
        // 枠の無い窓（外形と中身が同じ）なら、そのまま。
        assert_eq!(inner_size(fitted, (10, 10), (10, 10)), (1766, 1032));
    }
}
