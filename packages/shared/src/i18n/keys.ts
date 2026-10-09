/**
 * 文言の鍵の一覧。鍵ごとに、その文が受け取る引数の名前を並べる。
 * 鍵は `領域.部品.意味` の形にする。画面の文は領域を画面の名前に、サーバの文は領域を資源や層の名前にする。画面をまたぐものは common にする。
 * 辞書（ja.ts、en.ts）は `Record<MessageKey, string>` なので、ここに足した鍵が辞書に無いときも、辞書にあってここに無いときも、型検査で止まる。
 * 引数の名前が辞書の文の `{名前}` とそろっていることは、試験（t.test.ts）で見る。
 *
 * 先頭の 3 つ（common.button、session.kill、sessions.list）は仕組みを通すための見本で、まだ画面では使っていない。
 * その後ろは、サーバが出す文である。HTTP のエラー、起動の失敗、MCP の道具の説明と結果、Claude に渡す指示が入っている。
 */
export const MESSAGES = {
  // common
  'common.button.cancel': [],
  'common.file.sourceMissing': [],
  'common.list.or': [],
  'common.list.separator': [],
  // session
  'session.kill.confirm': ['name'],
  'session.error.notFound': [],
  'session.transcript.notOnThisComputer': [],
  'session.file.mustBeAbsolute': [],
  'session.file.notChanged': [],
  'session.status.noSuggestion': [],
  'session.status.invalid': [],
  'session.status.reasonMustBeString': [],
  'session.status.returnOnMustBeString': [],
  'session.status.returnTimeMustBeString': [],
  // sessions
  'sessions.list.count': ['n'],
  // account
  'account.error.notFound': [],
  'account.request.nameAndDir': [],
  'account.login.alreadyRunning': [],
  'account.switch.sameAccount': [],
  'account.switch.noTranscript': [],
  'account.switch.background': [],
  'account.switch.previousStillRunning': [],
  // http
  'http.request.send': ['field'],
  'http.request.sendString': ['field'],
  'http.auth.expired': [],
  'http.request.badContentType': [],
  'http.request.required': ['field'],
  'http.request.tooLarge': ['limit'],
  'http.request.mustBeString': ['field'],
  'http.request.needed': ['field'],
  'http.request.notJson': [],
  'http.request.badShape': [],
  'http.request.mustBeBoolean': ['field'],
  'http.entry.title': [],
  'http.entry.openFromUrl': ['command'],
  'http.entry.printUrl': ['command'],
  'http.entry.cookieStays': [],
  // run
  'run.launch.claudeMissing': ['label'],
  'run.tab.notFound': [],
  'run.error.notFound': [],
  'run.error.alreadyEnded': [],
  'run.jump.badRequest': ['headLen', 'maxHeads'],
  'run.launch.tmuxMissing': ['label'],
  'run.launch.claudeIsCmd': ['label'],
  'run.launch.dirMissing': ['path'],
  'run.launch.addDirDash': ['dir'],
  'run.launch.tmuxFailed': ['reason'],
  'run.launch.projectDirMissing': [],
  'run.launch.projectRequired': [],
  'run.resume.noTranscript': [],
  'run.error.sessionRunning': [],
  'run.error.runningOutside': [],
  'run.terminal.notInHangar': [],
  'run.attach.notBackground': [],
  'run.adopt.notRunning': [],
  'run.adopt.busy': [],
  'run.adopt.notCli': [],
  'run.adopt.inProgress': [],
  'run.adopt.noTranscript': [],
  'run.adopt.processUnverified': [],
  'run.adopt.notTerminated': [],
  'run.tab.shell': [],
  'run.tab.shellFailed': ['reason'],
  'run.tab.shellTitle': ['n'],
  'run.tab.agentNotClosable': [],
  'run.terminal.flagRefused': ['flag'],
  'run.terminal.resumeNeedsId': [],
  'run.adopt.recordRemained': ['id'],
  'run.adopt.resumeFailed': ['id', 'reason'],
  // project
  'project.error.notFound': [],
  'project.status.invalid': [],
  'project.resolve.badKind': [],
  'project.resolve.dirMissing': [],
  'project.create.pathNotDir': [],
  'project.create.badKind': [],
  'project.name.uncategorized': [],
  // artifact
  'artifact.error.addFailed': [],
  'artifact.error.notFound': [],
  // prompt
  'prompt.attachment.empty': [],
  // retention
  'retention.days.invalid': [],
  'retention.preview.fingerprintMissing': [],
  // settings
  'settings.error.empty': ['label'],
  'settings.path.missing': ['label', 'path'],
  'settings.path.notDirectory': ['label', 'path'],
  'settings.error.badValue': ['label'],
  'settings.path.badForm': ['label'],
  'settings.path.notOnPath': ['label', 'name'],
  'settings.path.notFile': ['label', 'path'],
  'settings.path.notExecutable': ['label', 'path'],
  'settings.terminalApp.invalid': ['label'],
  'settings.lmStudioUrl.invalid': ['label'],
  'settings.hourlyCap.invalid': ['label', 'max'],
  'settings.language.invalid': ['label', 'languages'],
  'settings.error.nothingToUpdate': [],
  'settings.summarizer.loopbackOnly': ['label'],
  'settings.label.workspaceRoot': [],
  'settings.label.claudeDir': [],
  'settings.label.tmuxPath': [],
  'settings.label.codePath': [],
  'settings.label.nodePath': [],
  'settings.label.claudePath': [],
  'settings.label.terminalApp': [],
  'settings.label.lmStudioUrl': [],
  'settings.label.lmStudioModel': [],
  'settings.label.summaryFallback': [],
  'settings.label.summaryHourlyCap': [],
  'settings.label.allowExternalSummarizer': [],
  'settings.label.syncClaudeConfig': [],
  'settings.label.language': [],
  // sync
  'sync.error.notConfigured': [],
  // system
  'system.index.rebuildFailed': ['reason'],
  // todo
  'todo.error.notFound': [],
  'todo.error.notCandidate': [],
  // usage
  'usage.statusline.badPayload': [],
  'usage.days.invalid': [],
} as const satisfies Record<`${string}.${string}.${string}`, readonly string[]>;

export type MessageKey = keyof typeof MESSAGES;
/** その鍵の文が受け取る引数の名前。引数の無い鍵では never である。 */
export type MessageParamName<K extends MessageKey> = (typeof MESSAGES)[K][number];
export type MessageParams<K extends MessageKey> = { [P in MessageParamName<K>]: string | number };
/** `t()` の最後の引数。引数の無い鍵では渡せず、ある鍵では省けない。 */
export type MessageArgs<K extends MessageKey> = [MessageParamName<K>] extends [never] ? [] : [params: MessageParams<K>];
export type Dictionary = Record<MessageKey, string>;
