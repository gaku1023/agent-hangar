//! 殻の実行ファイルを「ジョブの外で子を起こす役」として使う口（Windows だけ）。
//!
//! Windows の殻はサーバとその孫をジョブに入れ、Hangar を閉じるとジョブごと止める（winjob.rs）。
//! サーバがそのまま起こした外のアプリ（Windows Terminal、既定のターミナル、VS Code、ブラウザ）もジョブに入り、道連れになる。
//! Node は子を起こすときに `CREATE_BREAKAWAY_FROM_JOB` を付けられない。
//! そこでサーバは、殻の実行ファイルを `--hangar-breakaway <起こすもの> <引数の 1 行>` で起こす
//! （packages/server/src/external/breakaway.ts）。
//! 殻はこの印を見たら Tauri を立ち上げず、印を付けて子を起こし、子の終わりを待ってその終了コードで降りる。
//! 子とその子孫はジョブの外にいるので、Hangar を閉じても残る。macOS の `open` で開いたアプリと同じである。
//!
//! 引数の 1 行は、サーバが Windows の規則で引用し終えたものを、そのまま子のコマンド行の後ろに付ける（`raw_arg`）。
//! cmd.exe へ自前で組んだ行（`start "" ...`）を崩さずに渡すためである。
//! 標準入出力は受け継ぐので、サーバは子の出力と終了コードを、直に起こしたときと同じに受け取る。
use std::ffi::OsString;
use std::os::windows::process::CommandExt;
use std::process::Command;

use windows_sys::Win32::System::Threading::CREATE_BREAKAWAY_FROM_JOB;

/// 起こし役として振る舞う印。正本はここで、サーバの写し（external/breakaway.ts の BREAKAWAY_FLAG）との一致は試験で縛る。
pub const FLAG: &str = "--hangar-breakaway";

/// 拒まれた（ERROR_ACCESS_DENIED）。外側のジョブが抜けるのを許していないときに返る。
const ERROR_ACCESS_DENIED: i32 = 5;

/// 引数（先頭は自分の実行ファイル）が起こし役の印で始まっていれば、子を起こして終了コードを返す。印が無ければ None。
pub fn run_if_requested(args: &[OsString]) -> Option<i32> {
    if args.get(1).map(|a| a.as_os_str()) != Some(std::ffi::OsStr::new(FLAG)) {
        return None;
    }
    let Some(program) = args.get(2) else {
        eprintln!("{FLAG}: 起こすものがありません");
        return Some(2);
    };
    let line = args.get(3).cloned().unwrap_or_default();
    Some(run(program, &line))
}

fn command(program: &OsString, line: &OsString, flags: u32) -> Command {
    let mut cmd = Command::new(program);
    if !line.is_empty() {
        cmd.raw_arg(line);
    }
    // 窓の無いコンソールを持たせる。cmd.exe を経て start で開く端末の窓は、start が別に作るので出る。
    cmd.creation_flags(crate::winjob::CREATE_NO_WINDOW | flags);
    cmd
}

/// 子をジョブの外で起こし、終わりを待って終了コードを返す。
/// 外側のジョブが抜けるのを許していなければ、印を付けずに起こし直す（psmux のサーバの起こし方と同じ）。
pub fn run(program: &OsString, line: &OsString) -> i32 {
    let spawned = match command(program, line, CREATE_BREAKAWAY_FROM_JOB).spawn() {
        Err(e) if e.raw_os_error() == Some(ERROR_ACCESS_DENIED) => {
            command(program, line, 0).spawn()
        }
        r => r,
    };
    match spawned.and_then(|mut c| c.wait()) {
        Ok(status) => status.code().unwrap_or(1),
        Err(e) => {
            eprintln!("{}: {e}", program.to_string_lossy());
            1
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::winjob::tests::{in_job, is_alive, kill_pid, wait_until};
    use crate::winjob::Job;
    use std::path::{Path, PathBuf};
    use std::process::Stdio;
    use std::time::Duration;

    #[test]
    fn without_the_flag_the_shell_starts_as_usual() {
        assert_eq!(run_if_requested(&[OsString::from("Hangar.exe")]), None);
        assert_eq!(
            run_if_requested(&["Hangar.exe".into(), "hangar://session/1".into()]),
            None
        );
    }

    #[test]
    fn the_child_exit_code_comes_back() {
        let args: Vec<OsString> = vec![
            "Hangar.exe".into(),
            FLAG.into(),
            "cmd.exe".into(),
            "/d /c exit 7".into(),
        ];
        assert_eq!(run_if_requested(&args), Some(7));
    }

    #[test]
    fn a_missing_program_is_a_failure_not_a_panic() {
        let args: Vec<OsString> = vec![
            "Hangar.exe".into(),
            FLAG.into(),
            "hangar-no-such-program.exe".into(),
        ];
        assert_eq!(run_if_requested(&args), Some(1));
        assert_eq!(
            run_if_requested(&["Hangar.exe".into(), FLAG.into()]),
            Some(2)
        );
    }

    // 引数の 1 行は引用し直さずに子へ渡る。サーバが cmd.exe 向けに組んだ行が崩れないこと。
    #[test]
    fn the_line_reaches_the_child_as_is() {
        let dir = tempfile::tempdir().unwrap();
        let out = dir.path().join("out.txt");
        let line = format!("/d /s /c \"echo [a  b] \"q\" > \"{}\"\"", out.display());
        assert_eq!(run(&"cmd.exe".into(), &line.into()), 0);
        let text = std::fs::read_to_string(&out).unwrap();
        assert_eq!(text.trim_end(), "[a  b] \"q\"");
    }

    const ROLE_ENV: &str = "HANGAR_BREAKAWAY_ROLE";
    const DIR_ENV: &str = "HANGAR_BREAKAWAY_DIR";

    fn role(name: &str, dir: &Path) -> Command {
        let mut cmd = Command::new(std::env::current_exe().unwrap());
        cmd.args(["--ignored", "--exact", name, "--nocapture"])
            .env(ROLE_ENV, "1")
            .env(DIR_ENV, dir)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        cmd
    }

    /// サーバの役。`go` を待ってから、起こし役の口（run）で孫を起こす。
    /// 孫は自分の番号を書いて居座るので、run は戻らない。別のスレッドで呼び、自分も居座る。
    #[test]
    #[ignore]
    fn role_server() {
        if std::env::var_os(ROLE_ENV).is_none() {
            return;
        }
        let dir = PathBuf::from(std::env::var_os(DIR_ENV).unwrap());
        while !dir.join("go").exists() {
            std::thread::sleep(Duration::from_millis(20));
        }
        let exe: OsString = std::env::current_exe().unwrap().into();
        let line: OsString = "--ignored --exact breakaway::tests::role_app --nocapture".into();
        std::thread::spawn(move || run(&exe, &line));
        std::thread::sleep(Duration::from_secs(60));
    }

    /// 外のアプリの役。自分の番号を書いて居座る。
    #[test]
    #[ignore]
    fn role_app() {
        if std::env::var_os(ROLE_ENV).is_none() {
            return;
        }
        let dir = PathBuf::from(std::env::var_os(DIR_ENV).unwrap());
        std::fs::write(dir.join("app.tmp"), std::process::id().to_string()).unwrap();
        std::fs::rename(dir.join("app.tmp"), dir.join("app")).unwrap();
        std::thread::sleep(Duration::from_secs(60));
    }

    // ジョブの中のサーバが起こし役越しに起こした外のアプリは、ジョブの外にいて、ジョブを止めても（Hangar を閉じても）残る。
    #[test]
    fn an_app_started_through_the_launcher_outlives_the_job() {
        let dir = tempfile::tempdir().unwrap();
        let job = Job::new().unwrap();
        let mut server = role("breakaway::tests::role_server", dir.path())
            .creation_flags(crate::winjob::CREATE_NO_WINDOW)
            .spawn()
            .unwrap();
        job.assign(&server).unwrap();
        std::fs::write(dir.path().join("go"), "").unwrap();
        let file = dir.path().join("app");
        assert!(
            wait_until(Duration::from_secs(20), || file.exists()),
            "外のアプリが起きない"
        );
        let app: u32 = std::fs::read_to_string(&file)
            .unwrap()
            .trim()
            .parse()
            .unwrap();
        let outside = !in_job(&job, app);
        job.terminate();
        let _ = server.wait();
        std::thread::sleep(Duration::from_millis(500));
        let alive = is_alive(app);
        kill_pid(app);
        assert!(outside, "外のアプリがジョブに入った");
        assert!(alive, "ジョブを止めたら外のアプリまで止まった");
    }
}
