import test from 'node:test';
import assert from 'node:assert/strict';
import {readGuide,TOPICS} from '../src/guide.js';
import {detectHarness,harnessState,TESTED_HARNESS} from '../src/compat.js';

test('the guide covers the four topics and stays bounded',()=>{
  for(const topic of TOPICS) {
    const value=readGuide(topic);
    assert.equal(value.topic,topic);
    assert.deepEqual(value.topics,TOPICS);
    assert.ok(value.text.length>200&&value.text.length<3000,`${topic} must stay a bounded read`);
    assert.match(value.text,new RegExp(topic==='download'?'JAND_KERNEL_':topic==='safety'?'untrusted':'jand_'));
  }
  assert.equal(readGuide('unknown').topic,'overview','an unknown topic falls back to the overview');
  assert.equal(readGuide(undefined).topic,'overview');
});

test('the download guide names the pinned version, both origins and the import path',()=>{
  const text=readGuide('download').text;
  assert.match(text,/jand 0\.5\.0/);
  assert.match(text,/GitHub/);
  assert.match(text,/Settings/);
  assert.match(text,/JAND_KERNEL_UNSUPPORTED/);
});

test('harness detection is best effort and never throws',()=>{
  assert.equal(detectHarness({app:{version:'0.2.1-rc.5'}}),'0.2.1-rc.5');
  assert.equal(detectHarness({get:name=>name==='app'?{version:'1.2.3'}:undefined}),'1.2.3');
  assert.equal(detectHarness({app:{version:'not-a-version'}}),null);
  assert.equal(detectHarness({get(){throw new Error('missing');}}),null);
  assert.equal(detectHarness(undefined),null);
  assert.equal(harnessState(null),'unknown');
  assert.equal(harnessState(TESTED_HARNESS),'tested');
  assert.equal(harnessState('9.9.9'),'untested');
});
