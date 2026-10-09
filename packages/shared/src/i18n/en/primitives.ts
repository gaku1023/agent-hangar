import type { primitivesKeys } from '../keys/primitives.ts';
import type { AreaDictionary } from '../messageSpec.ts';

export const primitivesEn: AreaDictionary<typeof primitivesKeys> = {
  'primitives.clamp.collapse': 'Collapse',
  'primitives.clamp.expand': 'Show all ({rest} more {rest|line|lines})',
  'primitives.commandLine.copyLabel': 'Copy {name}',
  'primitives.listbox.placeholder': 'Select',
  'primitives.listbox.search': 'Search {label}',
  'primitives.listbox.hintMove': 'Navigate',
  'primitives.listbox.hintChoose': 'Select',
  'primitives.rollingNumber.unavailable': 'Not available',
  'primitives.stepper.decrease': 'Decrease {label}',
  'primitives.stepper.increase': 'Increase {label}',
};
