/**
 * `codex --help` の Commands の欄を読む。名前（サブコマンドと別名）だけを取り出す。
 * 外のターミナルの codex の横取り（D1 の BUILTIN_CODEX_SUBCOMMANDS）の一覧が、codex の実際の一覧とずれていないかを見張る道具である（docs/design.md「Codex の互換の見張り」）。
 */
export type CodexHelp = { commands: string[]; aliases: string[] };

export function parseCodexHelp(text: string): CodexHelp | null {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim() === 'Commands:');
  if (start < 0) return null;
  const commands: string[] = [];
  const aliases: string[] = [];
  let sawCommand = false;
  for (const l of lines.slice(start + 1)) {
    if (l.trim() === '') { if (sawCommand) break; continue; }
    // 欄は 2 字下げ。説明の続きの行はもっと深い。
    const m = /^ {2}([a-z][a-z0-9-]*)(?:\s{2,}|$)/.exec(l);
    if (m) { commands.push(m[1]!); sawCommand = true; }
    for (const a of /\[aliases?: ([^\]]+)\]/.exec(l)?.[1]?.split(',') ?? []) aliases.push(a.trim());
  }
  return { commands: commands.sort(), aliases: aliases.sort() };
}

/** 外のターミナルの横取りが素通しにするサブコマンド。resume は ID が 1 つのときだけ hangar の起動へ写すので、一覧には入らない。 */
export const HELP_ONLY_COMMANDS: readonly string[] = ['resume'];

/**
 * 横取りの組み込みの一覧（D1 の BUILTIN_CODEX_SUBCOMMANDS）と codex の --help のずれ。空ならそろっている。
 * 一覧に無いサブコマンドは、利用者がそれを打つと hangar の起動に化けてしまう。一覧にだけあるものは、消えたサブコマンドである。
 */
export function builtinSubcommandDrifts(help: CodexHelp, builtin: readonly string[]): string[] {
  const want = new Set([...help.commands.filter((c) => !HELP_ONLY_COMMANDS.includes(c)), ...help.aliases]);
  const have = new Set(builtin);
  return [
    ...[...want].filter((c) => !have.has(c)).sort().map((c) => `in codex --help but not in the intercept list: ${c}`),
    ...[...have].filter((c) => !want.has(c)).sort().map((c) => `in the intercept list but not in codex --help: ${c}`),
  ];
}
