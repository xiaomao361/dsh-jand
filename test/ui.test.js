import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';
import {z} from 'zod';

const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const localeSandbox={};
vm.runInNewContext(fs.readFileSync(path.join(root,'ui/locale.js'),'utf8')+'\nglobalThis.__locale={zh,en};',localeSandbox);
const t=key=>localeSandbox.__locale.zh[key]??key;

// A tiny hook renderer: every component keeps its own state frame keyed by tree
// position, and effects run only when their dependencies change. This is enough
// to render the shipped Client bundle and read what a user would actually see.
function createRuntime(){
  const frames=new Map();
  let current=null,dirty=false;
  const pending=[];
  const frame=key=>{
    if(!frames.has(key))frames.set(key,{states:[],deps:[],index:0});
    return frames.get(key);
  };
  const React={
    createElement:(type,props,...children)=>({type,props:{...(props??{}),children:children.length<=1?children[0]:children}}),
    useState(initial){
      const f=current,slot=f.index++;
      if(!(slot in f.states))f.states[slot]=typeof initial==='function'?initial():initial;
      return [f.states[slot],next=>{const value=typeof next==='function'?next(f.states[slot]):next;if(!Object.is(f.states[slot],value)){f.states[slot]=value;dirty=true;}}];
    },
    useEffect(effect,deps){const f=current,slot=f.index++;const key=JSON.stringify(deps??null);if(f.deps[slot]===key)return;f.deps[slot]=key;pending.push({run:effect});},
    useCallback(callback){current.index++;return callback;},
    useMemo(factory){current.index++;return factory();},
    useRef(value){const f=current,slot=f.index++;if(!(slot in f.states))f.states[slot]={current:value};return f.states[slot];},
    useId(){return 'ui'+(current.index++);}
  };
  const render=(node,key)=>{
    if(node==null||node===false||node===true)return null;
    if(typeof node==='string'||typeof node==='number')return String(node);
    if(Array.isArray(node))return node.map((child,index)=>render(child,key+'/'+index));
    if(typeof node.type==='function'){
      const f=frame(key);current=f;f.index=0;
      const output=node.type(node.props);
      current=null;
      return render(output,key+'>');
    }
    return {type:node.type,props:{...node.props,children:render(node.props.children,key+'/c')}};
  };
  return {React,render,pending,reset(){dirty=false;pending.length=0;},changed:()=>dirty};
}
async function loadPanel(React){
  let exported=null;
  vm.runInNewContext(fs.readFileSync(path.join(root,'client.js'),'utf8'),{window:{__ModuleLoader__:{load:module=>{exported=module.factory(name=>name==='react'?React:name==='zod'?{z}:undefined);}}}});
  assert.ok(exported,'client bundle did not expose a factory');
  let Panel=null;
  await exported.apply({locale:{register(){}},remote:{$mount:async()=>{}},inject:(_deps,injector)=>injector({remote:{jandPanel:{read:async()=>({ok:true,value:{status:{}}})}},slots:{inject:(_name,load)=>load(),register:(spec,component)=>{Panel=component;assert.equal(spec.name,'settings.section');}}})});
  assert.ok(Panel,'settings section was not registered');
  return Panel;
}
const status=(overrides={})=>({relay:'https://jand.zhou-wei.com',health:{state:'online',access:false},creation:'anonymous_allowed',tokenConfigured:false,kernel:{state:'ready',platform:'win32-x64',version:'0.5.0',supported:true,signed:false},...overrides});
async function mount(view,actions={}){
  const runtime=createRuntime();
  const Panel=await loadPanel(runtime.React);
  const props={t,read:async request=>request?.mode==='connection'?{status:view.status}:view,configure:actions.configure??(async()=>{}),prepare:actions.prepare??(async()=>{}),importKernel:actions.importKernel??(async()=>{}),saveToken:async()=>{}};
  let tree=null;
  const paint=async()=>{
    for(let pass=0;pass<12;pass++){
      runtime.reset();tree=runtime.render({type:Panel,props},'panel');
      for(const effect of runtime.pending)await effect.run();
      // Drained promises may set state after their effect returns.
      await new Promise(resolve=>setTimeout(resolve,0));
      if(!runtime.changed())break;
    }
    return tree;
  };
  return {paint};
}
function texts(node,out=[]){
  if(node==null||node===false)return out;
  if(typeof node==='string'||typeof node==='number'){out.push(String(node));return out;}
  if(Array.isArray(node)){for(const child of node)texts(child,out);return out;}
  texts(node.props?.children,out);return out;
}
const joined=tree=>texts(tree).join(' ');
function find(tree,predicate){
  if(!tree||typeof tree!=='object')return null;
  if(Array.isArray(tree)){for(const child of tree){const found=find(child,predicate);if(found)return found;}return null;}
  if(predicate(tree))return tree;
  return find(tree.props?.children,predicate);
}
const button=(tree,label)=>find(tree,node=>node.type==='button'&&node.props?.children===label);
const input=(tree)=>find(tree,node=>node.type==='input'&&node.props?.placeholder!==undefined);

test('unsupported platforms warn on the home card and inside settings before any action',async()=>{
  const view={status:status({kernel:{state:'unsupported',platform:'win32-arm64',version:'0.5.0',supported:false,published:['darwin-arm64','win32-x64']}}),conversations:[]};
  const panel=await mount(view);
  const home=await panel.paint();
  assert.match(joined(home),/当前系统没有官方内核，暂时无法协作/);
  assert.match(joined(home),/Windows ARM64/);
  const manage=button(home,t('manage'));
  assert.ok(manage,'manage button missing');
  manage.props.onClick();
  const settings=await panel.paint();
  assert.match(joined(settings),/当前系统缺少官方内核/);
  assert.match(joined(settings),/darwin-arm64 · win32-x64/);
  assert.equal(button(settings,t('prepare')).props.disabled,true,'prepare must stay disabled without a published runtime');
});

test('default relay and unsigned runtime are stated plainly',async()=>{
  const panel=await mount({status:status({kernel:{state:'not_downloaded',platform:'win32-x64',version:'0.5.0',supported:true,signed:false,sources:['github.com','jand.zhou-wei.com']}}),conversations:[]});
  const home=await panel.paint();
  assert.match(joined(home),/消息经默认公共中继转发/);
  button(home,t('manage')).props.onClick();
  const settings=await panel.paint();
  assert.match(joined(settings),/默认公共中继 https:\/\/jand\.zhou-wei\.com/);
  assert.match(joined(settings),/Windows 版没有代码签名/);
  assert.match(joined(settings),/下载来源：github\.com · jand\.zhou-wei\.com/);
  assert.equal(button(settings,t('prepare')).props.disabled,false,'prepare must stay available when a runtime is published');
});

test('a kernel prepared from the pinned backup says so',async()=>{
  const panel=await mount({status:status({kernel:{state:'ready',platform:'win32-x64',version:'0.5.0',supported:true,signed:false,sources:['github.com','jand.zhou-wei.com'],origin:{source:'backup',host:'jand.zhou-wei.com',at:'2026-11-05T08:00:00.000Z'}}}),conversations:[]});
  button(await panel.paint(),t('manage')).props.onClick();
  const settings=await panel.paint();
  assert.match(joined(settings),/上次由备用源 jand\.zhou-wei\.com 准备/);
  assert.equal(button(settings,t('prepare')),null,'a prepared runtime offers no prepare action');
});

test('a kernel download failure is reported with its cause instead of a generic error',async()=>{
  const failure=new Error('JAND_KERNEL_OFFLINE: the kernel download host is unreachable. Downloads come from github.com.');
  const panel=await mount({status:status({kernel:{state:'not_downloaded',platform:'win32-x64',version:'0.5.0',supported:true,signed:false}}),conversations:[]},{prepare:async()=>{throw failure;}});
  button(await panel.paint(),t('manage')).props.onClick();
  const settings=await panel.paint();
  await button(settings,t('prepare')).props.onClick();
  const failed=await panel.paint();
  assert.match(joined(failed),/连不上下载地址/);
  assert.match(joined(failed),/JAND_KERNEL_OFFLINE/);
});

test('an offline file can be imported from settings and is verified before use',async()=>{
  const seen=[];
  const panel=await mount({status:status({kernel:{state:'not_downloaded',platform:'win32-x64',version:'0.5.0',supported:true,signed:false}}),conversations:[]},{importKernel:async request=>{seen.push(request.path);}});
  button(await panel.paint(),t('manage')).props.onClick();
  const settings=await panel.paint();
  assert.match(joined(settings),/从本机文件导入/);
  assert.match(joined(settings),/只接受与固定版本一致、哈希匹配的文件/);
  const action=()=>button(settings,t('importFileAction'));
  assert.equal(action().props.disabled,true,'import stays disabled until a path is given');
  input(settings).props.onChange({target:{value:'C:\\Users\\you\\Downloads\\jand-0.5.0-windows-amd64.zip'}});
  const filled=await panel.paint();
  assert.equal(button(filled,t('importFileAction')).props.disabled,false);
  await button(filled,t('importFileAction')).props.onClick();
  assert.deepEqual(seen,['C:\\Users\\you\\Downloads\\jand-0.5.0-windows-amd64.zip']);
  const done=await panel.paint();
  assert.match(joined(done),/导入完成/);
});

test('a file that fails verification is reported with its own cause',async()=>{
  const failure=new Error('JAND_KERNEL_IMPORT: the imported file matches neither the official 0.5.0 archive nor its runtime for win32-x64.');
  const panel=await mount({status:status({kernel:{state:'not_downloaded',platform:'win32-x64',version:'0.5.0',supported:true,signed:false}}),conversations:[]},{importKernel:async()=>{throw failure;}});
  button(await panel.paint(),t('manage')).props.onClick();
  input(await panel.paint()).props.onChange({target:{value:'C:\\tmp\\jand.zip'}});
  const settings=await panel.paint();
  await button(settings,t('importFileAction')).props.onClick();
  const failed=await panel.paint();
  assert.match(joined(failed),/都不匹配/);
  assert.match(joined(failed),/JAND_KERNEL_IMPORT/);
});

test('preparation progress is shown while the runtime downloads',async()=>{
  const panel=await mount({status:status({kernel:{state:'not_downloaded',platform:'win32-x64',version:'0.5.0',supported:true,signed:false},preparation:{stage:'download',source:'jand.zhou-wei.com',received:1572864,total:4214572,platform:'win32-x64'}}),conversations:[]});
  button(await panel.paint(),t('manage')).props.onClick();
  const settings=await panel.paint();
  assert.match(joined(settings),/正在下载 · 1\.5 MB \/ 4\.0 MB/);
});

test('progress without a declared size still reports what arrived',async()=>{
  const panel=await mount({status:status({kernel:{state:'not_downloaded',platform:'win32-x64',version:'0.5.0',supported:true,signed:false},preparation:{stage:'verify',source:'github.com',received:2048,total:null,platform:'win32-x64'}}),conversations:[]});
  button(await panel.paint(),t('manage')).props.onClick();
  assert.match(joined(await panel.paint()),/正在校验归档 · 已下载 2 KB/);
});

test('settings state the harness compatibility baseline instead of implying full support',async()=>{
  const panel=await mount({status:status({harness:{version:null,tested:'0.2.1-rc.5',state:'unknown'}}),conversations:[]});
  button(await panel.paint(),t('manage')).props.onClick();
  assert.match(joined(await panel.paint()),/兼容性基于 DSH 0\.2\.1-rc\.5 实测/);
  const other=await mount({status:status({harness:{version:'0.3.0',tested:'0.2.1-rc.5',state:'untested'}}),conversations:[]});
  button(await other.paint(),t('manage')).props.onClick();
  assert.match(joined(await other.paint()),/当前 DSH 0\.3\.0，兼容性只基于 0\.2\.1-rc\.5 实测/);
});
