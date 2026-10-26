import { placeholderTarget } from './placeholder.ts';

/** Codex（$CODEX_HOME）。S4 が本物にする。入切は configTargets と、その PC で Codex が有効か。 */
export const codexTarget = placeholderTarget('codex', (ctx) => ctx.codexEnabled && ctx.switches?.['codex'] === true);
