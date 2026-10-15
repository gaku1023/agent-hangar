import type { reportKeys } from '../keys/report.ts';
import type { AreaDictionary } from '../messageSpec.ts';

export const reportJa: AreaDictionary<typeof reportKeys> = {
  'report.tool.draft': 'hangar の不具合の報告か要望を、作者（公開リポジトリ gaku1023/agent-hangar の GitHub Issues）へ送るための下書きを作る。これだけでは送らない。利用者が報告や要望を作者へ送りたいと言ったときだけ使う。kind が bug なら symptom（症状）と steps（再現の手順）、request なら problem（困っていること）と proposal（欲しいもの）が要る。任意で bug は cause（原因の見立て）と fix（直し方の案）、request は alternatives（代わりの案）、どちらも notes（補足）。利用者の言語で、作者が読んで直せるよう具体的に書く。会話の中身、パス、プロジェクト名、私的な情報は書かない。環境の節は道具が埋め、私的な情報は機械でも伏せる。答えの指示に従い、全文を利用者に見せて承諾を得てから submit_issue_report を呼ぶ。',
  'report.tool.submit': 'draft_issue_report で作った下書きを、そのまま作者へ送る。gh でログイン済みなら issue を作り、そうでなければ下書きを埋めた GitHub のページをブラウザで開く（送信は利用者が押す）。伏せた後の題名と中身を全文そのまま利用者に見せ、送ってよいと言われたときだけ confirmed を true にして呼ぶ。利用者に聞かずに呼んではいけない。中身を直すときは draft_issue_report を呼び直す。',
  'report.param.kind': 'bug（不具合）か request（要望）。',
  'report.param.confirmed': '利用者が下書きの全文を読み、送ってよいと言ったときだけ true。',
  'report.section.symptom': '症状',
  'report.section.steps': '再現の手順',
  'report.section.cause': '原因の見立て',
  'report.section.fix': '直し方の案',
  'report.section.notes': '補足',
  'report.section.problem': '困っていること',
  'report.section.proposal': '欲しいもの',
  'report.section.alternatives': '代わりの案',
  'report.section.environment': '環境',
  'report.env.unknown': '不明',
  'report.args.kindInvalid': 'kind は bug か request です',
  'report.args.titleRequired': '題名（title）が要ります',
  'report.args.fieldRequired': 'この種類では {field} が要ります',
  'report.draft.instructionsGh': 'まだ送っていない。title と body を全文そのまま利用者に見せ、redactions の数だけ私的な情報を伏せたことと、similar に似た issue があればそれも伝える。同じ件の issue があれば送らずにそちらを案内する。利用者が送ってよいと言ったら、submit_issue_report に draft_id と confirmed: true を渡す。gh で issue を作るので、利用者の GitHub アカウントの名前で公開される。下書きは 30 分で消える。',
  'report.draft.instructionsBrowser': 'まだ送っていない。title と body を全文そのまま利用者に見せ、redactions の数だけ私的な情報を伏せたことと、similar に似た issue があればそれも伝える。同じ件の issue があれば送らずにそちらを案内する。利用者が送ってよいと言ったら、submit_issue_report に draft_id と confirmed: true を渡す。gh が使えないので、下書きを埋めた GitHub のページをブラウザで開き、最後の送信は利用者が押す（GitHub のアカウントが要る）。下書きは 30 分で消える。',
  'report.submit.notConfirmed': '利用者の承諾がありません。下書きの全文を利用者に見せ、送ってよいと言われたら confirmed: true を渡してください',
  'report.submit.draftNotFound': '下書き {id} が見つかりません（30 分で消えるか、送った後です）。draft_issue_report で新しく作ってください',
  'report.submit.browserNotice': 'まだ送っていません。GitHub の新しい issue のページをブラウザで開きました。利用者に、内容を確認して「Submit new issue」を押すよう伝えてください。開かなかったときは url を案内してください。',
  'report.submit.truncatedNote': '（長いため、後ろを省きました。全文は Claude Code の会話にあります）',
};
