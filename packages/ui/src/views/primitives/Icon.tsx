import { AppWindow, Archive, ArrowDown, ArrowDownToLine, ArrowRight, ArrowUp, Ban, Bot, Brain, CaseSensitive, Check, ChevronDown, ChevronRight, ChevronUp, CircleAlert, CircleCheck, CirclePause, CircleX, Clock, Ellipsis, FilePlus, Layers, ScrollText, Unplug, Cloud, Code, Columns2, Command, Copy, Download, ExternalLink, FileJson2, FilePenLine, FileText, FileX2, Folder, FolderInput, FolderSearch, FolderUp, GitBranch, GitFork, House, Info, ListChecks, ListFilter, Map as MapIcon, MessageCircleQuestion, MessagesSquare, Minus, PanelLeft, PanelRightClose, PanelRightOpen, Pencil, Plug, Plus, RefreshCw, RotateCcw, RotateCw, Search, Settings, Settings2, ShieldAlert, SkipForward, Sparkles, Sprout, Square, SquareTerminal, Terminal, TextSearch, Trash2, TriangleAlert, Undo2, Unlink, Workflow, Wrench, X, type LucideIcon } from 'lucide-react';

/** hangar の言葉からアイコンへの対応。View は lucide-react を直接 import せず、ここだけを通す。 */
const ICONS = {
  home: House,
  projects: Folder,
  sessions: MessagesSquare,
  settings: Settings,
  add: Plus,
  close: X,
  chevron: ChevronRight,
  chevronDown: ChevronDown,
  chevronUp: ChevronUp,
  sidebar: PanelLeft,
  search: Search,
  paneClose: PanelRightClose,
  paneOpen: PanelRightOpen,
  agent: Bot,
  shell: Terminal,
  subagent: Workflow,
  tool: Wrench,
  openTerminal: SquareTerminal,
  openEditor: Code,
  stop: Square,
  resume: RotateCcw,
  fork: GitFork,
  repoint: FolderSearch,
  archive: Archive,
  unlink: Unlink,
  warning: TriangleAlert,
  alert: CircleAlert,
  split: Columns2,
  edit: Pencil,
  promote: FolderUp,
  scratch: Sprout,
  resumeHere: Download,
  check: Check,
  minus: Minus,
  thinking: Brain,
  rawLog: FileJson2,
  permissionDefault: Settings2,
  permissionManual: MessageCircleQuestion,
  permissionAcceptEdits: FilePenLine,
  permissionPlan: MapIcon,
  permissionAuto: Sparkles,
  permissionDontAsk: Ban,
  permissionBypass: ShieldAlert,
  gitInit: GitBranch,
  moveFiles: FolderInput,
  appWindow: AppWindow,
  latest: ArrowDownToLine,
  retention: Clock,
  transcriptGone: FileX2,
  seeAll: ArrowRight,
  nothingRunning: CirclePause,
  fullText: TextSearch,
  nextWaiting: SkipForward,
  command: Command,
  rebuild: RefreshCw,
  filter: ListFilter,
  discard: Trash2,
  reset: Undo2,
  // 設定と初回の確認リスト。
  // alert（CircleAlert）は上の共通の並びにあるものを使う。
  copy: Copy,
  ok: CircleCheck,
  ng: CircleX,
  checks: ListChecks,
  recheck: RefreshCw,
  log: FileText,
  restart: RotateCw,
  info: Info,
  link: Plug,
  cloud: Cloud,
  externalLink: ExternalLink,
  prev: ArrowUp,
  next: ArrowDown,
  matchCase: CaseSensitive,
  // セッション画面の組み直し（UX 刷新 2 の 1）。
  more: Ellipsis,
  disconnected: Unplug,
  reconnect: RefreshCw,
  transcriptView: ScrollText,
  artifacts: Layers,
  fileNew: FilePlus,
  fileEdited: FilePenLine,
} as const satisfies Record<string, LucideIcon>;

export type IconName = keyof typeof ICONS;
export const ICON_NAMES = Object.keys(ICONS) as IconName[];

/** 大きさ 16、線幅 1.5 に固定する。16px に縮むと実際の線幅は 1px になり、13px の本文の太さと釣り合う。 */
export function Icon(props: { name: IconName; label?: string }) {
  const Glyph = ICONS[props.name];
  // ラベルを渡さなければ lucide が aria-hidden を付け、飾りとして読み上げから外れる。
  const a11y = props.label ? { role: 'img', 'aria-label': props.label } : {};
  return <Glyph className="icon" data-icon={props.name} size={16} strokeWidth={1.5} {...a11y} />;
}
