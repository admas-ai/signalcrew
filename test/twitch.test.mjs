import test from 'node:test';
import assert from 'node:assert/strict';
import {TwitchClient} from '../lib/twitch.mjs';
const turn=()=>new Promise(r=>setImmediate(r));
class FakeSocket{
  static instances=[];
  constructor(url){this.url=url;this.events={};this.closed=false;FakeSocket.instances.push(this);}
  addEventListener(k,f){(this.events[k]??=[]).push(f);}
  emit(k,data){for(const f of this.events[k]||[])f(data);}
  message(data){this.emit('message',{data:JSON.stringify(data)});}
  close(){if(this.closed)return;this.closed=true;this.emit('close',{});}
}
const welcome=(id='session')=>({metadata:{message_type:'session_welcome'},payload:{session:{id,keepalive_timeout_seconds:30}}});
const notification=(id='event',channel='owner')=>({metadata:{message_type:'notification',subscription_type:'channel.chat.message',message_id:id,message_timestamp:new Date().toISOString()},payload:{event:{broadcaster_user_id:channel,chatter_user_id:'viewer',message_id:id,message:{text:'!crew scan'}}}});
function fixture(overrides={}){
  FakeSocket.instances=[];let subscriptions=0,requests=[];
  const client=new TwitchClient({clientId:'test-client',WebSocketImpl:FakeSocket,fetchImpl:async(url,options)=>{
    requests.push({url,options});
    if(url.endsWith('/validate'))return Response.json({client_id:'test-client',scopes:['user:read:chat'],user_id:'owner',login:'captain'});
    if(url.endsWith('/subscriptions')){subscriptions++;return Response.json({data:[{id:'sub',status:'enabled'}]},{status:202});}
    throw new Error('No real provider calls allowed');
  },...overrides});
  client.tokens={access:'fake-access',refresh:'fake-refresh',expires:Date.now()+3600000};
  return {client,requests,subscriptions:()=>subscriptions};
}
test('validates identity, subscribes own channel with read-only scope and deduplicates chat',async()=>{
  const chat=[];const f=fixture({onChat:e=>chat.push(e)});
  await f.client.connect();const ws=FakeSocket.instances[0];ws.message(welcome());await turn();
  assert.equal(f.client.status().status,'connected');assert.equal(f.subscriptions(),1);
  const payload=JSON.parse(f.requests[1].options.body);assert.equal(payload.condition.broadcaster_user_id,'owner');assert.equal(payload.condition.user_id,'owner');
  ws.message(notification());ws.message(notification());ws.message(notification('other','stranger'));assert.equal(chat.length,1);
  const publicText=JSON.stringify(f.client.status());assert.equal(publicText.includes('fake-access'),false);f.client.disconnect();
});
test('migration keeps old socket until welcome and preserves the subscription',async()=>{
  const f=fixture();await f.client.connect();const old=FakeSocket.instances[0];old.message(welcome());await turn();
  old.message({metadata:{message_type:'session_reconnect'},payload:{session:{reconnect_url:'wss://eventsub.wss.twitch.tv/ws?reconnect=opaque'}}});
  const replacement=FakeSocket.instances[1];assert.equal(old.closed,false);replacement.message(welcome('new'));await turn();
  assert.equal(old.closed,true);assert.equal(f.subscriptions(),1);assert.equal(f.client.status().status,'connected');f.client.disconnect();
});
test('unsafe reconnect URLs cannot redirect tokens and revocation ends the connection',async()=>{
  const f=fixture();await f.client.connect();const ws=FakeSocket.instances[0];ws.message(welcome());await turn();
  ws.message({metadata:{message_type:'session_reconnect'},payload:{session:{reconnect_url:'wss://attacker.invalid/ws'}}});
  assert.equal(FakeSocket.instances.length,1);assert.equal(f.client.status().status,'error');
  ws.message({metadata:{message_type:'revocation'},payload:{}});assert.equal(f.client.status().status,'revoked');assert.equal(ws.closed,true);f.client.disconnect();
});
test('one-time refresh token is exchanged once under concurrent demand',async()=>{
  let refreshes=0;const client=new TwitchClient({clientId:'test',fetchImpl:async(url)=>{
    if(url.endsWith('/token')){refreshes++;await turn();return Response.json({access_token:'next',refresh_token:'rotated',expires_in:3600});}
    return Response.json({client_id:'test',scopes:['user:read:chat'],user_id:'owner'});
  }});client.tokens={access:'old',refresh:'once',expires:0};
  await Promise.all([client.ensureToken(),client.ensureToken()]);assert.equal(refreshes,1);assert.equal(client.tokens.refresh,'rotated');client.disconnect();
});
test('wrong client or missing scope fails before opening a socket',async()=>{
  const f=fixture({fetchImpl:async()=>Response.json({client_id:'wrong',scopes:[],user_id:'owner'})});
  await assert.rejects(f.client.connect());assert.equal(FakeSocket.instances.length,0);f.client.disconnect();
});
test('device polling respects the interval and disconnect cancels a pending grant',async()=>{
  let now=100000,tokenCalls=0,release;
  const f=fixture({now:()=>now,fetchImpl:async(url)=>{
    if(url.endsWith('/device'))return Response.json({device_code:'fake-device',user_code:'TEST-CODE',verification_uri:'https://www.twitch.tv/activate?public=true&device-code=TEST-CODE',expires_in:300,interval:5});
    tokenCalls++;await new Promise(r=>release=r);return Response.json({access_token:'cancelled',refresh_token:'cancelled',expires_in:3600});
  }});
  await f.client.startDevice();assert.equal((await f.client.pollDevice()).status,'pending');assert.equal(tokenCalls,0);
  now+=5000;const poll=f.client.pollDevice();await turn();f.client.disconnect();release();assert.equal((await poll).status,'cancelled');assert.equal(f.client.tokens,null);assert.equal(FakeSocket.instances.length,0);
});
test('disconnect during token validation cannot restore the old identity',async()=>{
  let release;
  const client=new TwitchClient({clientId:'test-client',fetchImpl:async()=>new Promise(r=>release=()=>r(Response.json({client_id:'test-client',scopes:['user:read:chat'],user_id:'owner'})))});
  client.tokens={access:'fake-access',refresh:'fake-refresh',expires:Date.now()+3600000};
  const validation=client.ensureToken();await turn();client.disconnect();release();
  await assert.rejects(validation);assert.equal(client.userId,null);assert.equal(client.tokens,null);
});
test('events queued on an old socket cannot contribute after reconnect',async()=>{
  const chat=[];const f=fixture({onChat:e=>chat.push(e)});
  await f.client.connect();const old=FakeSocket.instances[0];old.message(welcome());await turn();
  f.client.disconnect();f.client.tokens={access:'new-access',refresh:'new-refresh',expires:Date.now()+3600000};
  await f.client.connect();const fresh=FakeSocket.instances[1];fresh.message(welcome('fresh'));await turn();
  old.message(notification('late'));fresh.message(notification('fresh'));
  assert.deepEqual(chat.map(x=>x.messageId),['fresh']);f.client.disconnect();
});
