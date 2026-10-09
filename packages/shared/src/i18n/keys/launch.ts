import type { MessageSpec } from '../messageSpec.ts';

export const launchKeys = {
  'launch.injection.none': [],
  'launch.injection.body': ['memo', 'projectName', 'projectPath', 'todos'],
  'launch.mcpConfig.badId': [],
  'launch.add.label': [],
  'launch.chip.account': [],
  'launch.chip.addDirs': [],
  'launch.chip.effort': [],
  'launch.chip.model': [],
  'launch.chip.name': [],
  'launch.chip.worktree': [],
  'launch.chips.label': [],
  'launch.edit.addDirsHint': [],
  'launch.edit.modelOther': [],
  'launch.edit.namePlaceholder': [],
  'launch.edit.worktreePlaceholder': [],
  'launch.permission.label': [],
  'launch.permission.previous': [],
  'launch.value.default': [],
  'launch.value.dirCount': ['n'],
  'launch.value.none': [],
} as const satisfies MessageSpec;
