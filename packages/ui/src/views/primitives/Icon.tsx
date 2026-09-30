import { AppWindow, Archive, Ban, Bot, Brain, Check, ChevronDown, ChevronRight, Code, Columns2, Download, FileJson2, FilePenLine, FolderInput, FolderSearch, FolderUp, Folder, GitBranch, GitFork, House, Map as MapIcon, MessagesSquare, MessageCircleQuestion, Minus, PanelLeft, PanelRightClose, PanelRightOpen, Pencil, Plus, RotateCcw, Search, Settings, Settings2, ShieldAlert, Sparkles, Square, SquareTerminal, Terminal, TriangleAlert, Unlink, Workflow, Wrench, X, type LucideIcon } from 'lucide-react';

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
  split: Columns2,
  edit: Pencil,
  promote: FolderUp,
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
