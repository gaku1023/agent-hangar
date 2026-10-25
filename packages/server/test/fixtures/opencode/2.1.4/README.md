# opencode 2.1.4 の見本

- 採った日：2026-10-25
- 版：`opencode --version` の出力は `opencode v2.1.4`（`version.txt`）。
- 入れ方：Homebrew の `opencode`（`/opt/homebrew/bin/opencode`）。
- 採り方：空の環境から次の形で打ち、標準出力をそのまま保存した。
  serve は起こしていない。

```sh
/usr/bin/env -i HOME="$HOME" USER="$USER" LOGNAME="$LOGNAME" SHELL=/bin/zsh TMPDIR="$TMPDIR" \
  PATH=/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin LANG=en_US.UTF-8 opencode --help > help.txt
```

`help.txt` は手で直さない。
`provider/opencode/compat/cli.ts` の組み込みの一覧は、最も新しい見本の `help.txt` と揃える（`cli.test.ts` が突き合わせる）。
