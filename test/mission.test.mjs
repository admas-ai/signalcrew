import test from 'node:test';
import assert from 'node:assert/strict';
import {Mission,parseCommand} from '../lib/mission.mjs';

test('only exact supported commands count',()=>{
  assert.equal(parseCommand(' !CREW scan '),'scan');
  for(const text of ['scan','!crew scan now','!crew pay','hello !crew boost',null])assert.equal(parseCommand(text),null);
});
test('one account gets one contribution, including duplicate deliveries',()=>{
  const m=new Mission();m.startRound();
  assert.equal(m.contribute({userId:'1',messageId:'a',text:'!crew scan'}),true);
  assert.equal(m.contribute({userId:'1',messageId:'b',text:'!crew boost'}),false);
  assert.equal(m.contribute({userId:'2',messageId:'a',text:'!crew shield'}),false);
  assert.deepEqual(m.snapshot().counts,{scan:1,shield:0,boost:0});
  assert.equal(JSON.stringify(m.snapshot()).includes('userId'),false);
});
test('closed windows, stale messages and pause cannot contribute',()=>{
  let now=100000;const m=new Mission({now:()=>now});m.startRound();
  assert.equal(m.contribute({userId:'1',messageId:'a',text:'!crew scan',timestamp:now-5000}),false);
  now+=12000;m.pause();assert.equal(m.snapshot().remainingMs,18000);
  now+=90000;assert.equal(m.contribute({userId:'1',messageId:'b',text:'!crew scan'}),false);
  m.resume();assert.equal(m.snapshot().deadline,now+18000);now+=18000;
  assert.equal(m.contribute({userId:'1',messageId:'c',text:'!crew scan'}),false);
  assert.equal(m.tick(),true);assert.equal(m.phase,'debrief');
});
test('balanced crew can complete a full five-round rescue and produces aggregate evidence',()=>{
  const m=new Mission();
  for(let r=0;r<5;r++){
    m.startRound();for(const [i,a] of ['scan','shield','boost'].entries())m.contribute({userId:String(i),messageId:r+'-'+a,text:'!crew '+a});m.resolve();
  }
  assert.equal(m.phase,'rescued');assert.equal(m.receipts.length,5);assert.equal(m.signal,100);assert.equal(m.distance,150);
  assert.throws(()=>m.startRound());assert.equal(m.receipts[0].source,'Synthetic rehearsal');
});
test('boost-only and empty crews cannot win; reboot isolates mission history',()=>{
  const m=new Mission();
  for(let r=0;r<5;r++){m.startRound();m.contribute({userId:'x',messageId:String(r),text:'!crew boost'});m.resolve();}
  assert.equal(m.phase,'lost');m.reset('live');assert.equal(m.receipts.length,0);assert.equal(m.mode,'live');
  for(let r=0;r<5;r++){m.startRound();m.resolve();}assert.equal(m.phase,'lost');
});
