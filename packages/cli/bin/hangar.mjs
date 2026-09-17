#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const entry = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/index.ts');
const r = spawnSync(process.execPath, ['--import', 'tsx', entry, ...process.argv.slice(2)], { stdio: 'inherit' });
process.exit(r.status ?? 1);
