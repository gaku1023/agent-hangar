import type { reportKeys } from '../keys/report.ts';
import type { AreaDictionary } from '../messageSpec.ts';

export const reportJa: AreaDictionary<typeof reportKeys> = {
  'report.tool.draft': 'hangar の不具合の報告か要望を、作者（公開リポジトリ gaku1023/agent-hangar の GitHub Issues）へ送るための下書きを作成する。これだけでは送らない。ユーザーが報告や要望を作者へ送りたいと言ったときだけ使う。kind が bug なら symptom（症状）と steps（再現手順）、request なら problem（課題）と proposal（提案）が必要。任意で bug は cause（推定される原因）と fix（修正案）、request は alternatives（代替案）、どちらも notes（補足）。ユーザーの言語で、作者が読んで修正できるよう具体的に書く。会話の中身、パス、プロジェクト名、私的な情報は書かない。環境の節はツールが埋め、私的な情報は機械でも伏せる。答えの指示に従い、全文をユーザーに見せて承諾を得てから submit_issue_report を呼ぶ。',
  'report.tool.submit': 'draft_issue_report で作成した下書きを、そのまま作者へ送る。gh でログイン済みなら issue を作成し、そうでなければ下書きを埋めた GitHub のページをブラウザで開く（送信はユーザーがクリックする）。伏せた後の題名と中身を全文そのままユーザーに見せ、送ってよいと言われたときだけ confirmed を true にして呼ぶ。ユーザーに聞かずに呼んではいけない。中身を修正するときは draft_issue_report を呼び直す。',
  'report.param.kind': 'bug（不具合）か request（要望）。',
  'report.param.confirmed': 'ユーザーが下書きの全文を読み、送ってよいと言ったときだけ true。',
  'report.section.symptom': '症状',
  'report.section.steps': '再現手順',
  'report.section.cause': '推定される原因',
  'report.section.fix': '修正案',
  'report.section.notes': '補足',
  'report.section.problem': '課題',
  'report.section.proposal': '提案',
  'report.section.alternatives': '代替案',
  'report.section.environment': '環境',
  'report.env.unknown': '不明',
  'report.args.kindInvalid': 'kind には bug か request を指定してください',
  'report.args.titleRequired': 'タイトル（title）が必要です',
  'report.args.fieldRequired': 'この種類では {field} が必要です',
  'report.draft.instructionsGh': 'まだ送っていない。title と body を全文そのままユーザーに見せ、redactions の数だけ私的な情報を伏せたことと、similar に似た issue があればそれも伝える。同じ件の issue があれば送らずにそちらを案内する。ユーザーが送ってよいと言ったら、submit_issue_report に draft_id と confirmed: true を渡す。gh で issue を作成するので、ユーザーの GitHub アカウントの名前で公開される。下書きは 30 分で消える。',
  'report.draft.instructionsBrowser': 'まだ送っていない。title と body を全文そのままユーザーに見せ、redactions の数だけ私的な情報を伏せたことと、similar に似た issue があればそれも伝える。同じ件の issue があれば送らずにそちらを案内する。ユーザーが送ってよいと言ったら、submit_issue_report に draft_id と confirmed: true を渡す。gh が使えないので、下書きを埋めた GitHub のページをブラウザで開き、最後の送信はユーザーがクリックする（GitHub のアカウントが必要）。下書きは 30 分で消える。',
  'report.submit.notConfirmed': 'ユーザーの承諾がありません。下書きの全文をユーザーに見せ、送ってよいと言われたら confirmed: true を渡してください',
  'report.submit.draftNotFound': '下書き {id} が見つかりません（30 分で消えたか、送信済みです）。draft_issue_report で新しく作成してください',
  'report.submit.browserNotice': 'まだ送っていません。GitHub の新しい issue のページをブラウザで開きました。ユーザーに、内容を確認して「Submit new issue」をクリックするよう伝えてください。開かなかったときは url を案内してください。',
  'report.submit.truncatedNote': '（長いため末尾を省略しました。全文は Claude Code の会話にあります）',
};
