import test from 'node:test';
import assert from 'node:assert/strict';
import {progress} from '../src/progress.js';

test('open conversation and receiver lifecycle never claim that the Agent is working',()=>{
  for(const [listener,label] of [['running','receiving'],['starting','startingReception'],['stopping','stoppingReception'],['stopped','receptionStopped'],[undefined,'receptionUnknown']]){
    const value=progress({status:'active',reception:{listener},timeline:[]});
    assert.equal(value.phase,'conversationOpen');assert.equal(value.receiving,label);assert.equal(value.next,listener==='stopped'?'resumeNext':'canIntervene');
  }
});
test('paused, ended and unknown conversations retain their status even with stale reception failures',()=>{
  for(const [status,phase,next] of [['paused','needsDecision','decideNext'],['ended','conversationEnded','endedNext'],['unknown','progressUnknown','unknownNext']]){
    const value=progress({status,reception:{listener:'stopped',failures:5,lastOutcome:'failed'},timeline:[]});
    assert.equal(value.phase,phase);assert.equal(value.next,next);
  }
  assert.equal(progress({status:'active',reception:{failures:5}}).phase,'receptionSuspended');
  assert.equal(progress({status:'active',reception:{lastOutcome:'failed',listener:'stopped'}}).phase,'receptionFailed');
  assert.equal(progress({status:'active',reception:{lastOutcome:'failed',listener:'running'}}).phase,'conversationOpen');
});
test('waiting on an invitation or own proposal does not ask the user to approve again',()=>{
  assert.equal(progress({status:'waiting'}).phase,'waitingPeer');
  const timeline=[{kind:'checkpoint'},{kind:'proposal',from:'host'}];
  assert.equal(progress({status:'paused',role:'host',timeline}).phase,'waitingProposal');
  assert.equal(progress({status:'paused',role:'guest',timeline}).phase,'needsDecision');
});
test('unhandled messages and peer completion are progress records, not verified completion',()=>{
  const recent={kind:'done',from:'guest',text:'peer says complete'};
  const value=progress({status:'active',reception:{unacknowledged:1},timeline:[{kind:'message',text:'earlier'},recent,{kind:'checkpoint'}]});
  assert.equal(value.phase,'messagesPending');assert.equal(value.next,'pendingNext');assert.deepEqual(value.recent,recent);
  assert.equal(progress({status:'active',reception:{lastOutcome:'canceled',listener:'stopped'}}).phase,'conversationOpen');
});

test('pause explanations distinguish protocol reasons from untrusted peer summaries',()=>{
  for(const [text,reason] of [['all_done','pauseBothDone'],['any_done','pauseOneDone'],['budget','pauseLimit'],['unrecognized','pauseUnknown']]){
    assert.equal(progress({status:'paused',timeline:[{kind:'checkpoint',from:'relay',text}]}).reason,reason);
  }
  // The same text supplied by a peer is not a relay confirmation.
  assert.equal(progress({status:'paused',timeline:[{kind:'checkpoint',from:'guest',text:'all_done'}]}).reason,'pauseRequested');
  assert.equal(progress({status:'active',timeline:[{kind:'checkpoint',from:'relay',text:'all_done'},{kind:'resumed'}]}).reason,null);
});
