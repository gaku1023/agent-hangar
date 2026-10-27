# spikes

フェーズ 0 で、設計が頼る前提を確かめた記録。計画は `docs/plans/phase0-spikes.md`。

各フォルダには結果の `RESULT.md` だけを残している。
確かめに使ったコードと依存（`package.json`・`package-lock.json`）は、もう動かさないので外した。
古い依存に脆弱性の知らせが出るたびに、Dependabot が更新の PR を出し続けていたためである。

コードが要るときは、外す前の commit `c878fc1b` から戻す。

```bash
git restore --source=c878fc1b -- spikes/01-terminal
```
