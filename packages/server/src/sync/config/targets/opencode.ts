import { placeholderTarget } from './placeholder.ts';

/** opencode（~/.config/opencode）。S5 が本物にする。入切は configTargets と、その PC で opencode が有効か。 */
export const opencodeTarget = placeholderTarget('opencode', (ctx) => ctx.opencodeEnabled && ctx.switches?.['opencode'] === true);
