import type { MessageSpec } from '../messageSpec.ts';

export const readinessKeys = {
  'readiness.fix.claude': [],
  'readiness.fix.code': [],
  'readiness.fix.node': [],
  'readiness.fix.workspace': [],
  'readiness.problem.unset': [],
  'readiness.problem.notFile': ['path'],
  'readiness.problem.notExecutable': ['path'],
  'readiness.problem.missing': ['path'],
  'readiness.tool.autoFound': [],
  'readiness.tool.optional': [],
  'readiness.workspace.empty': [],
  'readiness.workspace.projects': ['n'],
} as const satisfies MessageSpec;
