import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {ConversationManager} from '../src/manager.js';
import {probeRelay,creationState,configure,status} from '../src/onboarding.js';
test('open, protected, unreachable and malformed relay states remain distinct',async()=>{
  const open=await probeRelay('https://fixture.example',async()=>new Response('{"status":"ok","access":false}'));
  assert.equal(creationState(open,false),'anonymous_allowed');
  assert.equal(creationState({state:'online',access:true},false),'token_required');
  assert.equal(creationState({state:'online',access:true},true),'token_configured');
  const invalid=await probeRelay('https://fixture.example',async()=>new Response('{}'));
  assert.equal(invalid.state,'invalid');assert.equal(invalid.access,null);
  assert.equal(creationState(await probeRelay('https://fixture.example',async()=>{throw Error();}),false),'relay_unavailable');
});
test('relay settings persist without changing DSH profile; a token never crosses origins',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-setup-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const manager=new ConversationManager({root,jobs:{},relay:'https://one.example'});
  manager.saveToken('synthetic-token-one');
  assert.equal((await status(manager,{probe:false})).creation,'relay_unavailable');
  configure(manager,{relay:'https://two.example/'});assert.equal(manager.creationTokenFile(),undefined);
  const resumed=new ConversationManager({root,jobs:{},relay:'https://one.example'});assert.equal(resumed.relay,'https://two.example');
  configure(manager,{relay:'https://one.example'});assert.ok(manager.creationTokenFile());
  manager.saveToken('synthetic-token-two');
  assert.ok(fs.readdirSync(path.join(root,'credentials')).some(n=>n.includes('.previous-')));
  assert.ok(!JSON.stringify(await status(manager,{probe:false})).includes('synthetic-token'));
});
