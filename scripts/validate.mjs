import {spawnSync} from 'node:child_process';
const result=spawnSync(process.execPath,['--test','tests/request.test.mjs'],{stdio:'inherit'});
process.exit(result.status ?? 1);
