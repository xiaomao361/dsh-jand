// Builds only an isolated development test binary. Never packages or installs it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
const sourceRoot = process.env.JAND_SOURCE_ROOT;
if (!sourceRoot) throw new Error('Set JAND_SOURCE_ROOT to a checkout of the pinned Jand revision.');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'jand-task-tests-'));
try{
 const binary=path.join(dir,'jand');
 const build=spawnSync('go',['build','-o',binary,'./cmd/jand'],{cwd:sourceRoot,stdio:'inherit'});
 if(build.status!==0)process.exitCode=build.status??1;
 else{const run=spawnSync(process.execPath,['--test','test/tasks.test.js','test/tasks.integration.js'],{cwd:path.dirname(import.meta.dirname),stdio:'inherit',env:{...process.env,JAND_TASK_TEST_BINARY:binary,ELECTRON_RUN_AS_NODE:'1'}});process.exitCode=run.status??1;}
}finally{fs.rmSync(dir,{recursive:true,force:true});}
