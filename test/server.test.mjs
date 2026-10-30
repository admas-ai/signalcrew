import test from 'node:test';
import assert from 'node:assert/strict';
import {createApp} from '../server.mjs';
async function fixture(){const app=createApp();await new Promise(r=>app.server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+app.server.address().port;const html=await(await fetch(base)).text();const key=html.match(/name="control-key" content="([^"]+)"/)[1];return {app,base,key};}
async function post(f,path,data,key=f.key,origin=f.base){return fetch(f.base+path,{method:'POST',headers:{'Content-Type':'application/json','X-Control-Key':key,Origin:origin},body:JSON.stringify(data)});}
test('server runs without credentials; controller/overlay and evidence keep secrets separate',async()=>{
  const f=await fixture();try{
    const state=await(await fetch(f.base+'/api/state')).json();assert.equal(state.mission.mode,'rehearsal');assert.equal(state.twitch.configured,false);
    const overlay=await(await fetch(f.base+'/overlay')).text();assert.equal(overlay.includes(f.key),false);
    const evidence=await(await fetch(f.base+'/api/evidence')).text();assert.equal(evidence.includes(f.key),false);assert.equal(evidence.includes('access_token'),false);
    for(const path of ['/.env','/lib/twitch.mjs','/package.json'])assert.equal((await fetch(f.base+path)).status,404);
  }finally{await f.app.close();}
});
test('cross-origin and unkeyed control requests cannot alter a mission',async()=>{
  const f=await fixture();try{
    assert.equal((await post(f,'/api/control',{action:'start'},'bad')).status,403);
    assert.equal((await post(f,'/api/control',{action:'start'},f.key,'https://attacker.invalid')).status,403);
    assert.equal(f.app.mission.phase,'ready');
  }finally{await f.app.close();}
});
test('local rehearsal flows through HTTP, and live mode rejects simulated contributions',async()=>{
  const f=await fixture();try{
    assert.equal((await post(f,'/api/control',{action:'start'})).status,200);
    assert.equal((await(await post(f,'/api/rehearsal',{action:'scan'})).json()).accepted,true);
    await post(f,'/api/control',{action:'resolve'});assert.equal(f.app.mission.receipts[0].participants,1);
    await post(f,'/api/control',{action:'reset',mode:'live'});
    assert.equal((await post(f,'/api/rehearsal',{action:'scan'})).status,409);
    assert.equal((await post(f,'/api/control',{action:'start'})).status,400);assert.equal(f.app.mission.phase,'ready');
  }finally{await f.app.close();}
});
test('lost Twitch connection pauses live gameplay without changing rehearsal',async()=>{
  const f=await fixture();try{
    f.app.mission.reset('live');f.app.mission.startRound();f.app.twitch.setStatus('disconnected','Lost connection');assert.equal(f.app.mission.phase,'paused');
    f.app.mission.reset('rehearsal');f.app.mission.startRound();f.app.twitch.setStatus('error','Disconnected');assert.equal(f.app.mission.phase,'collecting');
  }finally{await f.app.close();}
});
