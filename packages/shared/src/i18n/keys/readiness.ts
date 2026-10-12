import type { MessageSpec } from '../messageSpec.ts';

export const readinessKeys = {
  'readiness.fix.claude': [],
  'readiness.fix.git': [],
  'readiness.fix.node': [],
  'readiness.fix.workspace': [],
  'readiness.problem.unset': [],
  'readiness.problem.notFile': ['path'],
  'readiness.problem.notExecutable': ['path'],
  'readiness.problem.missing': ['path'],
  'readiness.problem.notAbsolute': ['path'],
  'readiness.problem.notNode': ['path'],
  'readiness.problem.wrongNode': ['path', 'found', 'foundArch', 'major', 'arch'],
  'readiness.tool.autoFound': [],
  'readiness.tool.optional': [],
  'readiness.workspace.projects': ['n'],
} as const satisfies MessageSpec;
