// Isolated command supervisor. Loss of the plugin IPC connection stops its
// process group; a model/session disappearing is never interpreted as success.
import fs from 'node:fs';
import path from 'node:path';
import {spawn,execFileSync} from 'node:child_process';
const [record]=process.argv.slice(2);
let child,group,stopping=false,settled=false,output='',size=0,overflow=false,killTimer;
const write=value=>{const tmp=record+'.'+process.pid;fs.writeFileSync(tmp,JSON.stringify(value),{mode:0o600});const fd=fs.openSync(tmp,'r');fs.fsyncSync(fd);fs.closeSync(fd);fs.renameSync(tmp,record);const dir=fs.openSync(path.dirname(record),'r');fs.fsyncSync(dir);fs.closeSync(dir);};
const alive=()=>{if(!group)return false;try{process.kill(-group,0);return true;}catch(e){if(e.code==='ESRCH')return false;if(e.code==='EPERM'){const rows=execFileSync('/bin/ps',['-A','-o','pgid=,pid='],{encoding:'utf8',timeout:1000}).trim().split('\n');return rows.some(row=>Number(row.trim().split(/\s+/)[0])===group);}throw e;}};
const finish=(state,detail)=>{if(settled)return;settled=true;clearTimeout(killTimer);write({state,detail,pid:group,output,overflow});if(process.connected)process.send({state,detail,output,overflow},()=>process.disconnect());};
const stop=()=>{
 if(stopping||settled)return;stopping=true;
 if(!group){finish('stopped','canceled before launch');return;}
 try{process.kill(-group,'SIGTERM');}catch(e){if(e.code!=='ESRCH'){finish('unknown','group termination failed');return;}}
 killTimer=setTimeout(()=>{if(settled)return;try{if(alive())process.kill(-group,'SIGKILL');}catch{finish('unknown','group kill failed');}},250).unref();
 const end=Date.now()+2000;
 const check=()=>{try{if(!alive()){finish('stopped','process group exit confirmed');return;}}catch(e){finish('unknown','group inspection failed: '+e.code+' '+e.message);return;}if(Date.now()>end){finish('unknown','group exit not confirmed');return;}setTimeout(check,25);};check();
};
process.on('disconnect',stop);
process.on('message',message=>{
 if(message.op==='stop'){stop();return;}
 if(message.op!=='start'||child||settled||stopping)return;
 write({state:'starting'});
 try{child=spawn(message.command,{shell:true,cwd:message.cwd,detached:true,stdio:['ignore','pipe','pipe'],env:{...process.env,JAND_PAGE:'off'}});group=child.pid;write({state:'running',pid:group});}
 catch{finish('failed','command launch failed');return;}
 const collect=data=>{size+=data.length;if(size>1024*1024){overflow=true;stop();}else output+=data;};child.stdout.on('data',collect);child.stderr.on('data',collect);
 child.on('error',()=>finish('failed','command launch failed'));
 child.on('close',(code,signal)=>{
  if(stopping)return;
  // A shell may exit leaving children in its group. They must also be stopped.
  try{if(alive()){stop();return;}}catch(e){finish('unknown','group inspection failed: '+e.code+' '+e.message);return;}
  finish(code===0?'finished':'failed',signal?'command terminated':`exit ${code}`);
 });
});
