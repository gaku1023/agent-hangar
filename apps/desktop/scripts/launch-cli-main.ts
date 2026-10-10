// bin\hangar.cmd が動かす入口。esbuild で 1 ファイルにまとめ、束の根へ launch-cli.mjs として置く。
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from './launch-cli.ts';

void run(path.dirname(fileURLToPath(import.meta.url)));
