import type { MessageSpec } from '../messageSpec.ts';

export const primitivesKeys = {
  'primitives.clamp.collapse': [],
  'primitives.clamp.expand': ['rest'],
  'primitives.commandLine.copyLabel': ['name'],
  'primitives.listbox.placeholder': [],
  'primitives.listbox.search': ['label'],
  'primitives.listbox.hintMove': [],
  'primitives.listbox.hintChoose': [],
  'primitives.rollingNumber.unavailable': [],
  'primitives.stepper.decrease': ['label'],
  'primitives.stepper.increase': ['label'],
} as const satisfies MessageSpec;
