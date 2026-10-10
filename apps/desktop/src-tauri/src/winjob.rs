//! Windows のジョブオブジェクト。殻が起こした子を、その子が起こした孫ごと止めるために使う。
//!
//! macOS では、サーバへ SIGTERM を送って待ち、残れば SIGKILL で止める（server.rs）。
//! 試しに起こす Node の候補は `setsid` で新しいグループの長にして、グループごと止める（node.rs）。
//! Windows には信号もプロセスのグループの一斉停止も無いので、子をジョブに入れ、ジョブごと止める。
//!
//! ジョブの性質は 2 つ。
//!
//! 1. 閉じたら中身を止める（`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`）。
//!    殻が落ちて手綱が閉じたときも、サーバと node-pty の端末などの孫は残らない。
//! 2. 自分から抜けることを許す（`JOB_OBJECT_LIMIT_BREAKAWAY_OK`）。
//!    psmux はサーバを `CREATE_BREAKAWAY_FROM_JOB` で起こし、ジョブの外へ出る（psmux 3.3.8 の `spawn_server_hidden`）。
//!    psmux のサーバと、その中で動く claude は、Hangar を閉じても止めない。macOS の tmux と同じである。
//!    抜けるのを黙って許す `JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK` は付けない。
//!    付けると孫がすべてジョブの外に出て、ジョブで止められるのがサーバ 1 つだけになる。
use std::io;
use std::os::windows::io::AsRawHandle;
use std::process::Child;

use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
    SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JOB_OBJECT_LIMIT_BREAKAWAY_OK, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};

/// 窓を持たない殻から子を起こすとき、子ごとに黒いコンソールの窓が開かないようにする作成の印。
pub const CREATE_NO_WINDOW: u32 = windows_sys::Win32::System::Threading::CREATE_NO_WINDOW;

/// ジョブに付ける制限。説明はこのファイルの冒頭にある。
pub const LIMIT_FLAGS: u32 = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_BREAKAWAY_OK;

/// 子の木を入れておくジョブ。落とす（Drop）と手綱が閉じ、中に残ったプロセスはすべて止まる。
pub struct Job(HANDLE);

// 手綱はカーネルの物の番号で、どのスレッドから使っても同じ物を指す。
// サーバの子は AppState の Mutex に入り、終了の処理は別のスレッドから呼ばれる。
unsafe impl Send for Job {}

impl Job {
    /// 名前の無いジョブを作り、制限を付ける。
    pub fn new() -> io::Result<Job> {
        let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if handle.is_null() {
            return Err(io::Error::last_os_error());
        }
        // ここから先で失敗しても、Drop が手綱を閉じる。
        let job = Job(handle);
        let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        info.BasicLimitInformation.LimitFlags = LIMIT_FLAGS;
        let ok = unsafe {
            SetInformationJobObject(
                job.0,
                JobObjectExtendedLimitInformation,
                &info as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION as *const core::ffi::c_void,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        };
        if ok == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(job)
    }

    /// 子をジョブに入れる。入れた後に子が起こす孫は、抜ける印を付けない限りジョブに入る。
    ///
    /// 起こしてから入れるまでの間に子が孫を起こすと、その孫はジョブの外に残る。
    /// サーバの Node も Node の候補も、起き上がるまでに孫を起こさないので、ここでは間に合う。
    pub fn assign(&self, child: &Child) -> io::Result<()> {
        let ok = unsafe { AssignProcessToJobObject(self.0, child.as_raw_handle() as HANDLE) };
        if ok == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }

    /// ジョブの中のプロセスをすべて止める。抜けた孫（psmux のサーバ）には届かない。
    pub fn terminate(&self) {
        unsafe {
            TerminateJobObject(self.0, 1);
        }
    }
}

impl Drop for Job {
    fn drop(&mut self) {
        // 最後の手綱が閉じると、KILL_ON_JOB_CLOSE で中身が止まる。
        unsafe {
            CloseHandle(self.0);
        }
    }
}

/// 子をジョブに入れる。ジョブを作れない、入れられないときは None を返し、子だけで続ける。
/// 入れられなくても子は動いている。止めるときは子だけを止める（孫は残りうる）。
pub fn contain(child: &Child) -> Option<Job> {
    let job = Job::new().ok()?;
    job.assign(child).ok()?;
    Some(job)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::path::{Path, PathBuf};
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};
    use windows_sys::Win32::Foundation::WAIT_TIMEOUT;
    use windows_sys::Win32::System::JobObjects::{
        IsProcessInJob, QueryInformationJobObject, JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK,
    };
    use windows_sys::Win32::System::Threading::{
        OpenProcess, TerminateProcess, WaitForSingleObject, CREATE_BREAKAWAY_FROM_JOB,
        PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE, PROCESS_TERMINATE,
    };

    /// その番号のプロセスがまだ動いているか。
    pub(crate) fn is_alive(pid: u32) -> bool {
        unsafe {
            let h = OpenProcess(PROCESS_SYNCHRONIZE, 0, pid);
            if h.is_null() {
                return false;
            }
            let alive = WaitForSingleObject(h, 0) == WAIT_TIMEOUT;
            CloseHandle(h);
            alive
        }
    }

    /// 後片付け。試験が残したプロセスを番号で止める。
    pub(crate) fn kill_pid(pid: u32) {
        unsafe {
            let h = OpenProcess(PROCESS_TERMINATE, 0, pid);
            if !h.is_null() {
                TerminateProcess(h, 1);
                CloseHandle(h);
            }
        }
    }

    /// 期限まで待って、条件が成り立てば真。
    pub(crate) fn wait_until(limit: Duration, mut cond: impl FnMut() -> bool) -> bool {
        let t0 = Instant::now();
        while t0.elapsed() < limit {
            if cond() {
                return true;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        cond()
    }

    fn in_job(job: &Job, pid: u32) -> bool {
        unsafe {
            let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            assert!(!h.is_null(), "pid {pid} を開けない");
            let mut result = 0;
            let ok = IsProcessInJob(h, job.0, &mut result);
            CloseHandle(h);
            assert!(ok != 0, "IsProcessInJob が失敗した");
            result != 0
        }
    }

    fn read_pid(file: &Path) -> Option<u32> {
        std::fs::read_to_string(file).ok()?.trim().parse().ok()
    }

    // 子と孫の役は、この試験の実行ファイル自身に演じさせる。
    // PowerShell などの外の道具を挟まないので、孫を起こす瞬間と、起こすときの印を試験の側で決められる。
    // 役の関数は #[ignore] の試験として置き、名指しで `--ignored --exact` を付けて起こす。
    const ROLE_ENV: &str = "HANGAR_WINJOB_ROLE";
    const DIR_ENV: &str = "HANGAR_WINJOB_DIR";

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

    /// 子の役。`go` が置かれるのを待ってから孫を起こし、孫の番号を `grandchild` に書いて居座る。
    /// `breakaway` が置かれていれば、孫を psmux と同じく `CREATE_BREAKAWAY_FROM_JOB` で起こす。
    #[test]
    #[ignore]
    fn role_parent() {
        if std::env::var_os(ROLE_ENV).is_none() {
            return;
        }
        use std::os::windows::process::CommandExt;
        let dir = PathBuf::from(std::env::var_os(DIR_ENV).unwrap());
        while !dir.join("go").exists() {
            std::thread::sleep(Duration::from_millis(20));
        }
        let mut flags = CREATE_NO_WINDOW;
        if dir.join("breakaway").exists() {
            flags |= CREATE_BREAKAWAY_FROM_JOB;
        }
        let grandchild = match role("winjob::tests::role_sleeper", &dir)
            .creation_flags(flags)
            .spawn()
        {
            Ok(c) => c,
            Err(e) => {
                // 起こせなかった理由を試験の側へ返す。待ちぼうけの期限切れで落ちるより読みやすい。
                std::fs::write(dir.join("error"), e.to_string()).unwrap();
                return;
            }
        };
        std::fs::write(dir.join("grandchild.tmp"), grandchild.id().to_string()).unwrap();
        std::fs::rename(dir.join("grandchild.tmp"), dir.join("grandchild")).unwrap();
        std::thread::sleep(Duration::from_secs(60));
    }

    /// 孫の役。ただ居座る。
    #[test]
    #[ignore]
    fn role_sleeper() {
        if std::env::var_os(ROLE_ENV).is_none() {
            return;
        }
        std::thread::sleep(Duration::from_secs(60));
    }

    /// 子をジョブに入れてから孫を起こさせ、孫の番号を返す。
    fn spawn_family(job: &Job, dir: &Path) -> (Child, u32) {
        use std::os::windows::process::CommandExt;
        let child = role("winjob::tests::role_parent", dir)
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .unwrap();
        job.assign(&child).unwrap();
        std::fs::write(dir.join("go"), "").unwrap();
        let file = dir.join("grandchild");
        let error = dir.join("error");
        assert!(
            wait_until(Duration::from_secs(20), || read_pid(&file).is_some()
                || error.exists()),
            "孫が起きない"
        );
        if let Ok(e) = std::fs::read_to_string(&error) {
            panic!("孫を起こせない: {e}");
        }
        (child, read_pid(&file).unwrap())
    }

    #[test]
    fn the_job_kills_on_close_and_lets_children_leave_only_on_purpose() {
        let job = Job::new().unwrap();
        let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        let ok = unsafe {
            QueryInformationJobObject(
                job.0,
                JobObjectExtendedLimitInformation,
                &mut info as *mut JOBOBJECT_EXTENDED_LIMIT_INFORMATION as *mut core::ffi::c_void,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                std::ptr::null_mut(),
            )
        };
        assert!(ok != 0);
        let flags = info.BasicLimitInformation.LimitFlags;
        assert!(flags & JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE != 0);
        assert!(flags & JOB_OBJECT_LIMIT_BREAKAWAY_OK != 0);
        // 黙って抜けるのを許すと、孫がみなジョブの外に出る。
        assert!(flags & JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK == 0);
    }

    // サーバが起こした孫（node-pty の端末、PowerShell の確かめなど）は、ジョブごと止まる。
    #[test]
    fn terminating_the_job_stops_the_child_and_its_grandchildren() {
        let dir = tempfile::tempdir().unwrap();
        let job = Job::new().unwrap();
        let (mut child, grandchild) = spawn_family(&job, dir.path());
        assert!(in_job(&job, grandchild));
        assert!(is_alive(grandchild));
        job.terminate();
        let _ = child.wait();
        let gone = wait_until(Duration::from_secs(10), || !is_alive(grandchild));
        if !gone {
            kill_pid(grandchild);
        }
        assert!(gone, "孫が残った");
    }

    // 殻が落ちて手綱が閉じたときも、子と孫は残らない。
    #[test]
    fn dropping_the_job_stops_the_child_and_its_grandchildren() {
        let dir = tempfile::tempdir().unwrap();
        let job = Job::new().unwrap();
        let (mut child, grandchild) = spawn_family(&job, dir.path());
        drop(job);
        let _ = child.wait();
        let gone = wait_until(Duration::from_secs(10), || !is_alive(grandchild));
        if !gone {
            kill_pid(grandchild);
        }
        assert!(gone, "孫が残った");
    }

    // psmux のサーバのように、自分から抜けて起こされた孫は止めない。
    #[test]
    fn a_grandchild_that_breaks_away_survives_the_job() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("breakaway"), "").unwrap();
        let job = Job::new().unwrap();
        let (mut child, grandchild) = spawn_family(&job, dir.path());
        assert!(!in_job(&job, grandchild));
        job.terminate();
        let _ = child.wait();
        // 止める合図が届き終わるだけの間を置いてから見る。
        std::thread::sleep(Duration::from_millis(500));
        let alive = is_alive(grandchild);
        kill_pid(grandchild);
        assert!(alive, "抜けた孫まで止まった");
    }

    // ここからは実物の psmux を相手にする。psmux が PATH に無ければ飛ぶ（CI の windows ジョブには入れてある）。
    // 利用者の psmux に触れないよう、置き場（PSMUX_DATA_DIR）と名前空間（-L）を分ける。
    // 予備のサーバを残さないよう PSMUX_NO_WARM を立てる。後始末は kill-session で、kill-server は呼ばない。
    // 分け方の正本は packages/server/test/psmux.ts である。
    const PSMUX_NS_ENV: &str = "HANGAR_WINJOB_PSMUX_NS";
    const PSMUX_SESSION: &str = "hangar-winjob";

    fn psmux(dir: &Path, ns: &str) -> Command {
        let mut cmd = Command::new("psmux");
        cmd.arg("-L")
            .arg(ns)
            .env("PSMUX_DATA_DIR", dir.join("psmux-data"))
            .env("PSMUX_NO_WARM", "1")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        cmd
    }

    fn has_psmux() -> bool {
        Command::new("psmux")
            .arg("-V")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    }

    /// 子の役（psmux）。`go` が置かれるのを待ってから psmux のセッションを作り、`done` を置いて居座る。
    /// hangar のサーバが psmux を起こすのと同じく、psmux の CLI はジョブの中で走り、psmux のサーバを起こす。
    #[test]
    #[ignore]
    fn role_psmux() {
        if std::env::var_os(ROLE_ENV).is_none() {
            return;
        }
        use std::os::windows::process::CommandExt;
        let dir = PathBuf::from(std::env::var_os(DIR_ENV).unwrap());
        let ns = std::env::var(PSMUX_NS_ENV).unwrap();
        while !dir.join("go").exists() {
            std::thread::sleep(Duration::from_millis(20));
        }
        let status = psmux(&dir, &ns)
            .args(["new-session", "-d", "-s", PSMUX_SESSION])
            .creation_flags(CREATE_NO_WINDOW)
            .status();
        std::fs::write(dir.join("done"), format!("{status:?}")).unwrap();
        std::thread::sleep(Duration::from_secs(60));
    }

    // psmux のサーバは、Hangar を閉じても止めない（macOS の tmux と同じ）。
    // ジョブの中から起こされても、psmux は自分からジョブを抜けるので、ジョブを止めても残る。
    #[test]
    fn the_psmux_server_outlives_the_job() {
        if !has_psmux() {
            eprintln!("psmux が無いので飛ばす");
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("psmux-data")).unwrap();
        let ns = format!("hangar-winjob-{}", std::process::id());
        let has_session = || {
            psmux(dir.path(), &ns)
                .args(["has-session", "-t", &format!("={PSMUX_SESSION}")])
                .status()
                .map(|s| s.success())
                .unwrap_or(false)
        };
        let job = Job::new().unwrap();
        let mut child = {
            use std::os::windows::process::CommandExt;
            role("winjob::tests::role_psmux", dir.path())
                .env(PSMUX_NS_ENV, &ns)
                .creation_flags(CREATE_NO_WINDOW)
                .spawn()
                .unwrap()
        };
        job.assign(&child).unwrap();
        std::fs::write(dir.path().join("go"), "").unwrap();
        let done = dir.path().join("done");
        assert!(
            wait_until(Duration::from_secs(30), || done.exists()),
            "psmux の new-session が終わらない"
        );
        let made = has_session();
        job.terminate();
        let _ = child.wait();
        std::thread::sleep(Duration::from_millis(500));
        let survived = has_session();
        // 自分が作ったセッションだけを止める。最後のセッションが消えると psmux のサーバも降りる。
        let _ = psmux(dir.path(), &ns)
            .args(["kill-session", "-t", &format!("={PSMUX_SESSION}")])
            .status();
        assert!(
            made,
            "psmux のセッションができていない: {}",
            std::fs::read_to_string(&done).unwrap_or_default()
        );
        assert!(survived, "ジョブを止めたら psmux のサーバまで止まった");
    }
}
