import type { readinessKeys } from '../keys/readiness.ts';
import type { AreaDictionary } from '../messageSpec.ts';

export const readinessEn: AreaDictionary<typeof readinessKeys> = {
  'readiness.fix.claude': 'Enter the absolute path of the claude command',
  'readiness.fix.code': 'Install the code command from VS Code',
  'readiness.fix.node': 'Enter the path of a Node with the same major version as the bundled server',
  'readiness.fix.workspace': 'Enter the folder that holds the directories with your sessions',
  'readiness.problem.unset': 'Not found',
  'readiness.problem.notFile': '{path} is not a file',
  'readiness.problem.notExecutable': '{path} is not executable',
  'readiness.problem.missing': '{path} was not found',
  'readiness.tool.autoFound': 'Found automatically',
  'readiness.tool.optional': 'Works without it',
  'readiness.workspace.empty': 'No directory with Claude sessions directly inside it',
  'readiness.workspace.projects': '{n} {n|project|projects}',
};
