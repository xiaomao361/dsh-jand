import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {createRequire} from 'node:module';
import {Context,Service} from '@deepseek-ai/cordis';
import {z} from 'zod';
import {ConversationManager} from '../src/manager.js';
import {mountPanel,panelRemote} from '../src/panel.js';
import {clientContribution} from '../src/panel-contract.js';
import {inspectLocal} from '../src/view.js';
import {atomic} from '../src/store.js';
const peer={signal:new AbortController().signal,principal:{kind:'owner'}};
async function gatewayFixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-panel-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const ctx=new Context(),fibers=[];
  for(const name of ['dsh-typert-registry','dsh-api-remote-access','dsh-api-gateway']) {const m=await import('@deepseek-ai/'+name);const f=ctx.plugin(m.default??m,{});await f;fibers.push(f);}
  const manager=new ConversationManager({root,jobs:{},fetcher:async()=>new Response('{"status":"ok","access":true}')});
  const p=ctx.plugin({name:'test-jand-panel',inject:['typert'],apply:child=>mountPanel(child,manager)});await p;fibers.push(p);
  t.after(async()=>{for(const f of fibers.reverse())await f.dispose();});
  return {root,ctx,manager,call:(name,request,p=peer)=>ctx.typertGateway.invokeRpc('jandPanel/'+name,{args:{request}},undefined,p)};
}
test('real DSH Gateway registers strict panel endpoints, protects credentials and rejects guests',async t=>{
  const {call,manager,ctx}=await gatewayFixture(t);
  assert.equal(panelRemote.descriptors.length,5);assert.equal(ctx.typert.local.list().filter(d=>d.namespace==='jandPanel').length,5);
  assert.ok(panelRemote.descriptors.some(d=>d.method==='importKernel'),'offline import must be a registered endpoint');
  const fetcher=manager.fetcher;
  let probes=0;
  manager.fetcher=async(...args)=>{probes++;return fetcher(...args);};
  const local=await call('read',{mode:'local'});
  assert.equal(local.ok,true);
  assert.equal(local.value.status.health.state,'unchecked');
  assert.deepEqual(local.value.conversations,[]);
  assert.equal(probes,0,'local history must not wait for the relay');
  const connection=await call('read',{mode:'connection'});
  assert.equal(connection.value.status.health.state,'online');
  assert.equal(probes,1);
  assert.equal('conversations' in connection.value,false);
  const first=await call('read',{});assert.equal(first.ok,true,JSON.stringify(first));assert.equal(first.value.status.creation,'token_required');
  const synthetic='synthetic-token-not-a-live-credential';
  const saved=await call('saveToken',{value:synthetic});assert.equal(saved.ok,true,JSON.stringify(saved));assert.ok(!JSON.stringify(saved).includes(synthetic));
  assert.ok(manager.creationTokenFile());
  const status=await call('read',{});assert.equal(status.value.status.creation,'token_configured');assert.ok(!JSON.stringify(status).includes(synthetic));
  assert.equal((await call('configure',{relay:'http://remote.example'})).ok,false);
  assert.equal((await call('read',{unknown:'input'})).ok,false);
  const guest={...peer,principal:{kind:'guest',id:'guest'}};assert.equal((await call('read',{},guest)).ok,false);
  assert.equal((await call('importKernel',{path:'/tmp/nope'},guest)).ok,false,'guests cannot import a runtime');
  const rejected=await call('importKernel',{path:'/tmp/does-not-exist-'+Date.now()});
  assert.equal(rejected.ok,false);assert.match(rejected.error.message,/JAND_KERNEL_IMPORT/);
  assert.deepEqual(clientContribution(z).descriptors.map(d=>[d.namespace,d.method]),panelRemote.descriptors.map(d=>[d.namespace,d.method]));
});
test('actual DSH Client Remote mounts the panel contract and round-trips through the native Host Gateway',async t=>{
  const f=await gatewayFixture(t),client=new Context();const fibers=[];
  const registry=await import('@deepseek-ai/dsh-typert-registry');const rf=client.plugin(registry.default);await rf;fibers.push(rf);
  class Connection extends Service {
    constructor(ctx){super(ctx,'connection');}
    interactions='none';
    rpc={open(){throw Error('No stream is expected for this unary fixture');},call:(_prefix,endpoint,payload,signal)=>f.ctx.typertGateway.invokeRpc(endpoint,payload,signal,peer)};
  }
  const cf=client.plugin(Connection);await cf;fibers.push(cf);
  const runtime=await import('@deepseek-ai/dsh-api-gateway/client');const remote=client.plugin(runtime);await remote;fibers.push(remote);
  t.after(async()=>{for(const fiber of fibers.reverse())await fiber.dispose();});
  const unmount=await client.remote.$mount(clientContribution(z));
  const result=await client.remote.jandPanel.read({});assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.value.status.creation,'token_required');
  await unmount();assert.equal(client.typert.remotes.list().length,0);
});

const uiRequire=createRequire(new URL('../.local/ui-test/package.json',import.meta.url));
const React=uiRequire('react');
const {create,act}=uiRequire('react-test-renderer');
globalThis.IS_REACT_ACT_ENVIRONMENT=true;
test('native Client factory registers a localized page; React renders safe timeline and saves token outside Agent tools',async t=>{
  const fixture=await gatewayFixture(t);let module,Component,callbacks,dictionaries;const clipboardWrites=[];
  vm.runInNewContext(fs.readFileSync(new URL('../client.js',import.meta.url),'utf8'),{window:{__ModuleLoader__:{load:m=>{module=m;}}},Intl,Date,console,navigator:{clipboard:{writeText:async text=>clipboardWrites.push(text)}}});
  const contribution=module.factory(name=>name==='react'?React:name==='zod'?{z}:null);
  // Use actual Cordis plugin injection and Client Remote, not a plain object
  // mock: only plugin contexts enforce dynamic namespace dependencies.
  const client=new Context(),fibers=[];let transportFailed=false;
  const registry=await import('@deepseek-ai/dsh-typert-registry');
  let fiber=client.plugin(registry.default);await fiber;fibers.push(fiber);
  class Connection extends Service {
    constructor(ctx){super(ctx,'connection');}
    interactions='none';
    rpc={open(){throw Error('No stream expected');},call:(_prefix,endpoint,payload,signal)=>{if(transportFailed)throw Error('synthetic-private-diagnostic');return fixture.ctx.typertGateway.invokeRpc(endpoint,payload,signal,peer);}};
  }
  class Locale extends Service {
    constructor(ctx){super(ctx,'locale');}
    register(_ns,d){dictionaries=d;}
    bind(){return key=>dictionaries.zh[key]??key;}
  }
  class Slots extends Service {
    constructor(ctx){super(ctx,'slots');}
    inject(_name,fn){return fn();}
    register(options,component){assert.equal(options.name,'settings.section');Component=component;callbacks=options.inject();}
  }
  for(const service of [Connection,Locale,Slots]){fiber=client.plugin(service);await fiber;fibers.push(fiber);}
  const runtime=await import('@deepseek-ai/dsh-api-gateway/client');
  fiber=client.plugin(runtime);await fiber;fibers.push(fiber);
  fiber=client.plugin(contribution);await fiber;fibers.push(fiber);
  t.after(async()=>{for(const f of fibers.reverse())await f.dispose();});
  assert.equal(typeof callbacks.read,'function');
  const tzh=key=>dictionaries.zh[key]??key;
  let renderer;
  await act(async()=>{renderer=create(React.createElement(Component,{t:tzh,...callbacks}));});
  t.after(async()=>{await act(async()=>renderer.unmount());});
  const click=async label=>act(async()=>renderer.root.findAllByType('button').find(n=>n.children.includes(label)).props.onClick());
  assert.equal(renderer.root.findAllByType('input').length,0,'configuration starts collapsed');
  assert.equal(renderer.root.findAllByType('img').length,0);
  assert.ok(!JSON.stringify(renderer.toJSON()).includes('开始一次协作'));
  await click('自建中继教程');
  assert.equal(renderer.root.findAllByType('li').length,7);
  assert.ok(renderer.root.findAllByType('a').some(n=>n.props.href.endsWith('/deploy/INSTALL.md')));
  await click('返回列表');
  await click('默认中继安全说明');
  assert.ok(JSON.stringify(renderer.toJSON()).includes('独立安全审计'));
  await click('返回列表');
  await click('管理');
  const input=renderer.root.findAllByType('input').find(n=>n.props.type==='password');
  const synthetic='ui-only-synthetic-token';
  await act(async()=>input.props.onChange({target:{value:synthetic}}));
  await click('保存令牌');
  assert.equal(renderer.root.findAllByType('input').find(n=>n.props.type==='password').props.value,'');
  assert.ok(fixture.manager.creationTokenFile());
  await click('收起');
  const chat='d'.repeat(32),directory=path.join(fixture.root,'home/chats');
  atomic(path.join(directory,chat+'.json'),{id:chat,role:'host',key:'secret-key',token:'secret-token'});
  const longText='<script>window.pwned=true</script>'+'long original content '.repeat(500);
  const lines=[{time:'2026-10-30T10:00:00Z',kind:'started',from:'host',text:'Goal: review the plugin'},
    {time:'2026-10-30T10:01:00Z',kind:'joined',from:'guest'},
    ...Array.from({length:25},(_,i)=>({time:'2026-10-30T10:02:00Z',kind:'message',from:i%2?'host':'guest',id:'m'+i,type:'note',text:'message-'+i})),
    {time:'2026-10-30T10:03:00Z',kind:'message',from:'host',id:'h1',type:'delivery',text:'old delivery'},
    {time:'2026-10-30T10:04:00Z',kind:'message',from:'host',id:'h2',type:'delivery',supersedes:'h1',text:longText}];
  fs.writeFileSync(path.join(directory,chat+'.transcript.jsonl'),lines.map(JSON.stringify).join('\n')+'\n');
  const invite='e'.repeat(32);atomic(path.join(directory,invite+'.json'),{id:invite,role:'host'});
  fs.writeFileSync(path.join(directory,invite+'.transcript.jsonl'),JSON.stringify({time:'2026-10-30T11:00:00Z',kind:'started',from:'host',text:'Invitation only'})+'\n');
  await click('刷新');
  assert.ok(JSON.stringify(renderer.toJSON()).includes('仅邀请 1'));
  assert.ok(JSON.stringify(renderer.toJSON()).includes('有交流 1'));
  assert.ok(!JSON.stringify(renderer.toJSON()).includes('1 轮'));
  assert.ok(!JSON.stringify(renderer.toJSON()).includes(chat),'raw IDs are absent from the home');
  assert.ok(!JSON.stringify(renderer.toJSON()).includes('进行中'));
  assert.deepEqual(renderer.root.findByProps({className:'jand-overview'}).findAllByType('dd').map(n=>n.children.join('')),['2','1','1','27']);
  await click('仅邀请 1');assert.equal(renderer.root.findByProps({className:'jand-history'}).findAllByType('li').length,1);
  await click('有交流 1');
  await act(async()=>renderer.root.findByProps({className:'jand-history'}).findByType('button').props.onClick());
  assert.equal(renderer.root.findAllByProps({className:'jand-history'}).length,0);
  const article=renderer.root.findByType('article');
  assert.deepEqual(article.findByProps({className:'jand-detail-stats'}).findAllByType('dd').map(n=>n.children.join('')),['27','14','13']);
  assert.ok(article.findAllByType('h3').some(n=>n.children.includes('协作摘要')));
  assert.equal(article.findByProps({className:'jand-chat-log'}).findAllByType('li').length,10,'chat is visible immediately');
  assert.ok(article.findAllByProps({className:'jand-chat-message jand-chat-self'}).length>0);
  assert.ok(article.findAllByProps({className:'jand-chat-message jand-chat-peer'}).length>0);
  assert.ok(!JSON.stringify(renderer.toJSON()).includes(longText),'full long text is absent before expansion');
  assert.ok(JSON.stringify(renderer.toJSON()).includes('<script>window.pwned=true</script>'));
  assert.equal(renderer.root.findAllByType('script').length,0);
  assert.equal(article.findAllByProps({className:'jand-transcript'}).length,1);
  const expand=article.findAllByType('button').find(n=>n.children.includes('展开全文'));
  await act(async()=>expand.props.onClick());
  assert.ok(JSON.stringify(renderer.toJSON()).includes(longText));
  const transcript=article.findByProps({className:'jand-transcript'});
  await click('加载更早的 10 条记录');
  assert.equal(transcript.findAllByType('li').length,20,'earlier messages prepend without removing recent messages');
  assert.ok(JSON.stringify(renderer.toJSON()).includes(longText),'expanded message remains expanded after loading earlier records');
  await click('加载更早的 9 条记录');
  assert.equal(transcript.findAllByType('li').length,29);
  assert.equal(article.findAllByProps({className:'jand-chat-system'}).length,2,'start and join are separate from participant bubbles');
  assert.ok(JSON.stringify(renderer.toJSON()).includes('记录开始'));
  const technical=article.findByProps({className:'jand-section jand-technical'});assert.equal(technical.props.open,undefined);
  assert.ok(JSON.stringify(renderer.toJSON()).includes('取代 h1'));
  assert.ok(!JSON.stringify(renderer.toJSON()).includes('secret-token'));
  assert.ok(!JSON.stringify(renderer.toJSON()).includes(synthetic));
  await click('返回列表');
  await click('管理');
  const relayInput=renderer.root.findAllByType('input').find(n=>n.props.type==='url');
  await act(async()=>relayInput.props.onChange({target:{value:'http://127.0.0.1:18787'}}));
  await click('保存地址');assert.equal(fixture.manager.relay,'http://127.0.0.1:18787');assert.equal(fixture.manager.creationTokenFile(),undefined);
  await click('恢复默认');assert.equal(fixture.manager.relay,'https://jand.zhou-wei.com');assert.ok(fixture.manager.creationTokenFile());
  fixture.manager.fetcher=async()=>new Response('{"status":"ok","access":false}');
  await click('刷新');assert.equal(renderer.root.findAllByType('input').filter(n=>n.props.type==='password').length,0);
  fixture.manager.fetcher=async()=>{throw Error('offline');};
  await click('刷新');assert.equal(renderer.root.findAllByType('input').filter(n=>n.props.type==='password').length,0);
  fixture.manager.fetcher=async()=>new Response('{"status":"ok","access":true}');
  transportFailed=true;
  let failedRenderer;
  await act(async()=>{failedRenderer=create(React.createElement(Component,{t:tzh,...callbacks}));});
  t.after(async()=>{await act(async()=>failedRenderer.unmount());});
  let rendered=JSON.stringify(failedRenderer.toJSON());assert.ok(rendered.includes(dictionaries.zh.failed));assert.ok(!rendered.includes(dictionaries.zh.loading));assert.ok(!rendered.includes(dictionaries.zh.empty));assert.ok(!rendered.includes('synthetic-private-diagnostic'));
  assert.equal(failedRenderer.root.findByProps({className:'jand-page'}).props['aria-busy'],false);
  transportFailed=false;
  await act(async()=>failedRenderer.root.findAllByType('button').find(n=>n.children.includes('刷新')).props.onClick());
  rendered=JSON.stringify(failedRenderer.toJSON());assert.ok(!rendered.includes(dictionaries.zh.failed));assert.ok(rendered.includes('协作记录'));
});
