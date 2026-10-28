import { AppWindow, Archive, Bell, BookOpen, Calendar, ChefHat, ClipboardList, FlaskConical, Gamepad2, Image, Inbox, Mail, NotebookPen, Server, Shield, Sigma, Smartphone, ArrowDown, ArrowDownToLine, ArrowRight, ArrowUp, Ban, Bot, Brain, CaseSensitive, ChartColumn, Check, ChevronDown, ChevronRight, ChevronUp, CircleAlert, CircleCheck, CirclePause, CircleX, Clock, Ellipsis, Equal, FilePlus, Layers, ScrollText, Unplug, Cloud, Code, Columns2, Command, Copy, Download, ExternalLink, FileDiff, FileJson2, FilePenLine, FileText, FileX2, Folder, FolderInput, FolderOpen, FolderPlus, FolderSearch, FolderUp, GitBranch, GitFork, House, Info, ListChecks, ListFilter, Map as MapIcon, MessageCircleQuestion, Monitor, MessagesSquare, Maximize2, Minimize2, Rows2, Minus, PanelLeft, PanelRightClose, PanelRightOpen, Paperclip, Pencil, Play, Plug, Plus, RefreshCw, RotateCcw, RotateCw, Search, Settings, Settings2, ShieldAlert, SlidersHorizontal, SkipForward, Sparkles, Sprout, Square, SquareTerminal, SquareX, Terminal, TextSearch, Trash2, TriangleAlert, Undo2, Unlink, Workflow, Wrench, X, type LucideIcon } from 'lucide-react';
import type { ArtifactIconName } from '../../presenters/artifactIcon.ts';

/** hangar の言葉からアイコンへの対応。View は lucide-react を直接 import せず、ここだけを通す。 */
const ICONS = {
  home: House,
  projects: Folder,
  folder: Folder,
  folderPlus: FolderPlus,
  folderOpen: FolderOpen,
  sessions: MessagesSquare,
  settings: Settings,
  add: Plus,
  close: X,
  attach: Paperclip,
  chevron: ChevronRight,
  chevronDown: ChevronDown,
  chevronUp: ChevronUp,
  sidebar: PanelLeft,
  search: Search,
  paneClose: PanelRightClose,
  paneOpen: PanelRightOpen,
  restore: Minimize2,
  maximize: Maximize2,
  splitRight: Columns2,
  splitDown: Rows2,
  equalize: Equal,
  closeOthers: SquareX,
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
  // hangar が自動で付けた Done の印（4a、試作の A の ✦）。
  autoMark: Sparkles,
  permissionDontAsk: Ban,
  permissionBypass: ShieldAlert,
  gitInit: GitBranch,
  moveFiles: FolderInput,
  // セッションのメニューの「プロジェクトを変更…」と「削除…」（ゴミ箱へ移す）。
  moveSession: FolderInput,
  trash: Trash2,
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
  // git の表示（0.5.0）。ブランチは枝、worktree は分かれ道、差分はファイルの差、他の PC は画面。
  branch: GitBranch,
  // エディタの「テスト」。見本のファイルを開いてみる。
  play: Play,
  worktree: GitFork,
  diff: FileDiff,
  otherPc: Monitor,
  // 一覧の行の、ノートがあることを示す印。
  // 設定の目次の「一般」。
  general: SlidersHorizontal,
  // 設定の目次の「使用量」。
  usage: ChartColumn,
  // ヘッダーのベルと、知らせの一覧の種類の印。
  bell: Bell,
  sync: RefreshCw,
  reminder: Clock,
  // アプリの更新（右下の札と、設定の「Hangar について」の目次）。
  download: Download,
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

/** アーティファクトの札の頭の絵。語との対応は presenters/artifactIcon.ts。 */
const ARTIFACT_GLYPHS = {
  document: FileText,
  chart: ChartColumn,
  checklist: ListChecks,
  clipboard: ClipboardList,
  notebook: NotebookPen,
  book: BookOpen,
  mail: Mail,
  inbox: Inbox,
  calendar: Calendar,
  diagram: Workflow,
  map: MapIcon,
  image: Image,
  game: Gamepad2,
  phone: Smartphone,
  settings: Settings,
  wrench: Wrench,
  terminal: SquareTerminal,
  code: Code,
  shield: Shield,
  search: Search,
  server: Server,
  compare: Columns2,
  math: Sigma,
  flask: FlaskConical,
  recipe: ChefHat,
} as const satisfies Record<ArtifactIconName, LucideIcon>;

/** 淡い青の四角に線画を置く（試作の案 B）。飾りなので読み上げから外す。 */
export function ArtifactIcon(props: { name: ArtifactIconName }) {
  const Glyph = ARTIFACT_GLYPHS[props.name];
  return <span className="artifact-icon" aria-hidden="true"><Glyph className="icon" data-icon={`artifact-${props.name}`} size={14} strokeWidth={1.75} /></span>;
}
