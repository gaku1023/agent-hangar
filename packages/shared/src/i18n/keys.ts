/**
 * 文言の鍵の一覧。鍵ごとに、その文が受け取る引数の名前を並べる。
 * 鍵は `画面.部品.意味` の形にする。画面をまたぐものは、画面のところを common にする。
 * 辞書（ja.ts、en.ts）は `Record<MessageKey, string>` なので、ここに足した鍵が辞書に無いときも、辞書にあってここに無いときも、型検査で止まる。
 * 引数の名前が辞書の文の `{名前}` とそろっていることは、試験（t.test.ts）で見る。
 *
 * 今ある 3 つは仕組みを通すための見本で、まだ画面では使っていない。
 */
export const MESSAGES = {
  'common.button.cancel': [],
  'common.chip.nameValue': ['name', 'value'],
  'common.popover.details': [],
  'common.label.uncategorized': [],
  'home.band.label': [],
  'home.band.attention': [],
  'home.band.running': [],
  'home.band.pending': [],
  'home.band.attentionSummary': ['waiting', 'reminders'],
  'home.band.runningSummary': ['busy', 'idle'],
  'home.band.pendingSummary': ['n'],
  'home.band.collapse': [],
  'home.band.searchNote': [],
  'home.band.waited': ['time'],
  'home.band.working': ['time'],
  'home.band.external': [],
  'home.band.noDate': [],
  'home.band.reminderTime': ['time'],
  'home.band.answer': [],
  'home.band.move': [],
  'home.band.open': [],
  'home.band.changeDate': [],
  'home.band.confirm': [],
  'home.band.dismiss': [],
  'home.band.actionFor': ['action', 'name'],
  'session.kill.confirm': ['name'],
  'sessions.list.count': ['n'],
} as const satisfies Record<`${string}.${string}.${string}`, readonly string[]>;

export type MessageKey = keyof typeof MESSAGES;
/** その鍵の文が受け取る引数の名前。引数の無い鍵では never である。 */
export type MessageParamName<K extends MessageKey> = (typeof MESSAGES)[K][number];
export type MessageParams<K extends MessageKey> = { [P in MessageParamName<K>]: string | number };
/** `t()` の最後の引数。引数の無い鍵では渡せず、ある鍵では省けない。 */
export type MessageArgs<K extends MessageKey> = [MessageParamName<K>] extends [never] ? [] : [params: MessageParams<K>];
export type Dictionary = Record<MessageKey, string>;
