import type { muxKeys } from '../keys/mux.ts';
import type { AreaDictionary } from '../messageSpec.ts';

export const muxEn: AreaDictionary<typeof muxKeys> = {
  'mux.status.notInstalled': '{name} is not installed',
  'mux.status.stillMissing': '{name} still not found. You may need to restart Hangar after installing it',
  'mux.action.recheck': 'Check again',
  'mux.action.checking': 'Checking…',
  'mux.badge.installed': 'Installed',
  'mux.badge.missing': 'Not installed',
  'mux.info.version': 'Version {version}',
  'mux.desc.windows': 'Runs and keeps your sessions. On Windows, psmux takes the place of tmux',
  'mux.desc.other': 'Runs and keeps your sessions',
  'mux.run.windows': 'Run this command in PowerShell',
  'mux.run.other': 'Run this command in a terminal',
  'mux.guide.title': 'You need {name} to start a session',
  'mux.guide.lead.windows': 'On Windows, psmux keeps sessions running in place of tmux. Run this command in PowerShell',
  'mux.guide.lead.other': 'tmux keeps sessions running. Run this command in a terminal',
  'mux.guide.recheck': 'Installed, check again',
  'mux.guide.found.title': '{name} found',
  'mux.guide.found.lead': 'Found version {version}. Starting the session',
  'mux.guide.found.leadNoVersion': 'Found it. Starting the session',
  'mux.guide.start': 'Start',
};
