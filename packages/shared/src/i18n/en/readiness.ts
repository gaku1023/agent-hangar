import type { readinessKeys } from '../keys/readiness.ts';
import type { AreaDictionary } from '../messageSpec.ts';

export const readinessEn: AreaDictionary<typeof readinessKeys> = {
  'readiness.fix.claude': 'Enter the absolute path of the claude command',
  'readiness.fix.git': 'Install git. hangar works without it, but branches and uncommitted counts are not shown',
  'readiness.fix.node': 'Enter the full path to the node executable of a Node with the same major version and architecture as the bundled server',
  'readiness.fix.workspace': 'Leave it empty or choose another location',
  'readiness.problem.unset': 'Not found',
  'readiness.problem.notFile': '{path} is not a file',
  'readiness.problem.notExecutable': '{path} is not executable',
  'readiness.problem.missing': '{path} was not found',
  'readiness.problem.notAbsolute': '{path} is not a full path',
  'readiness.problem.notNode': '{path} does not answer as Node',
  'readiness.problem.wrongNode': '{path} is Node {found} ({foundArch}). Node {major} ({arch}) is needed',
  'readiness.tool.autoFound': 'Found automatically',
  'readiness.tool.optional': 'Works without it',
  'readiness.workspace.missing': 'This location was not found',
  'readiness.workspace.projects': '{n} {n|project|projects}',
};
