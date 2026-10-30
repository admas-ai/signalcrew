const controlKey=document.querySelector('meta[name="control-key"]').content;
const overlay=location.pathname==='/overlay';
if(overlay)document.body.classList.add('overlay');
const $=id=>document.getElementById(id);let state,clockOffset=0,busy=false,authTimer;
const phaseNames={ready:'READY FOR LAUNCH',collecting:'CREW WINDOW OPEN',paused:'MISSION PAUSED',debrief:'SECTOR COMPLETE',rescued:'RELAY RESCUED',lost:'MISSION ENDED'};
async function post(path,data={}){
  const res=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json','X-Control-Key':controlKey},body:JSON.stringify(data)});
  const json=await res.json();if(!res.ok)throw new Error(json.error||'Request failed');return json;
}
function render(s){
  state=s;const m=s.mission,t=s.twitch;clockOffset=m.serverNow-Date.now();
  $('modeNotice').textContent=m.mode==='rehearsal'?'LOCAL REHEARSAL · Synthetic crew commands. No live Twitch participation.':`TWITCH MISSION · ${t.status==='connected'?'Chat connected to #'+t.channel:'Chat unavailable; live rounds cannot start.'}`;
  $('modeNotice').classList.toggle('live',m.mode==='live');
  $('connection').textContent=t.status.toUpperCase();$('connection').classList.toggle('connected',t.status==='connected');
  $('twitchDetail').textContent=t.configured?t.detail:'Set TWITCH_CLIENT_ID in .env, then restart to connect.';
  $('sector').textContent=String(m.round||1).padStart(2,'0')+' / 05';
  for(const field of ['hull','energy','signal','distance']){
    $(field).textContent=m[field]+(field==='distance'?' / 135':'');$(field+'Bar').value=m[field];
  }
  $('phase').textContent=phaseNames[m.phase];$('weather').textContent=m.weather.name;$('hint').textContent=m.phase==='paused'?m.pauseReason:m.weather.hint;
  $('crewTotal').textContent=m.participants+' crew contribution'+(m.participants===1?'':'s');
  for(const a of ['scan','shield','boost']){$(a+'Count').textContent=m.counts[a];$(a+'Meter').style.width=(m.participants?100*m.counts[a]/m.participants:0)+'%';}
  $('sourceFooter').textContent=m.mode==='rehearsal'?'SYNTHETIC REHEARSAL':'TWITCH EVENTSUB';
  $('result').textContent=m.phase==='rescued'?'Relay rescued. You brought the signal home.':m.phase==='lost'?'The relay is still out there. Rebalance the crew and try again.':'';
  $('start').disabled=busy||!['ready','debrief'].includes(m.phase)||(m.mode==='live'&&t.status!=='connected');
  $('start').textContent=m.phase==='ready'?'Launch round 1':'Launch next round';
  $('pause').disabled=busy||m.phase!=='collecting';$('resume').disabled=busy||m.phase!=='paused'||(m.mode==='live'&&t.status!=='connected');
  $('resolve').disabled=busy||m.phase!=='collecting';$('rehearsal').hidden=m.mode!=='rehearsal';
  for(const b of document.querySelectorAll('[data-rehearsal]'))b.disabled=busy||m.phase!=='collecting';
  $('connect').disabled=busy||!t.configured||['connected','connecting','authorizing'].includes(t.status);
  $('retry').disabled=busy||!t.configured||!['error','disconnected'].includes(t.status);
  $('history').replaceChildren();
  if(!m.receipts.length){const p=document.createElement('p');p.textContent='No completed rounds yet.';$('history').append(p);}
  for(const r of m.receipts){
    const row=document.createElement('div');row.className='log-row';
    for(const text of [`SECTOR ${r.round}`,`${r.participants} crew · ${r.actions.scan} scan / ${r.actions.shield} shield / ${r.actions.boost} boost`,`${r.source} · Hull ${r.after.hull} · Signal ${r.after.signal} · Distance ${r.after.distance}`]){const span=document.createElement('span');span.textContent=text;row.append(span);}
    $('history').append(row);
  }
  updateClock();
}
function updateClock(){if(!state)return;const m=state.mission;const ms=m.phase==='paused'?m.remainingMs:m.deadline?m.deadline-(Date.now()+clockOffset):null;$('timer').textContent=ms===null?'—':Math.max(0,Math.ceil(ms/1000))+'s';}
setInterval(updateClock,200);
async function act(fn){if(busy)return;busy=true;$('error').textContent='';if(state)render(state);try{await fn();}catch(e){$('error').textContent=e.message;}finally{busy=false;if(state)render(state);}}
for(const b of document.querySelectorAll('[data-control]'))b.addEventListener('click',()=>act(async()=>render(await post('/api/control',{action:b.dataset.control}))));
for(const b of document.querySelectorAll('[data-reset]'))b.addEventListener('click',()=>act(async()=>{
  if(state?.mission.phase!=='ready'&&!confirm('Replace the current mission and its round log?'))return;
  render(await post('/api/control',{action:'reset',mode:b.dataset.reset}));
}));
for(const b of document.querySelectorAll('[data-rehearsal]'))b.addEventListener('click',()=>act(()=>post('/api/rehearsal',{action:b.dataset.rehearsal})));
$('connect').addEventListener('click',()=>act(async()=>{
  const d=await post('/api/auth/start');$('device').hidden=false;$('activation').href=d.verificationUri;$('deviceCode').textContent=d.userCode;
  clearInterval(authTimer);authTimer=setInterval(async()=>{try{const result=await post('/api/auth/poll');if(!['pending','authorizing'].includes(result.status)){clearInterval(authTimer);$('device').hidden=true;$('deviceCode').textContent='';$('activation').removeAttribute('href');}}catch{clearInterval(authTimer);$('error').textContent='Authorization interrupted. Connect again.';}},2000);
}));
$('retry').addEventListener('click',()=>act(()=>post('/api/auth/retry')));
$('disconnect').addEventListener('click',()=>act(async()=>{clearInterval(authTimer);$('device').hidden=true;$('deviceCode').textContent='';$('activation').removeAttribute('href');await post('/api/auth/disconnect');}));
const events=new EventSource('/api/events');
events.onmessage=e=>render(JSON.parse(e.data));
events.onerror=()=>{if(state){$('connection').textContent='DISPLAY OFFLINE';$('modeNotice').textContent='Display connection lost. Refresh before continuing.';}};
fetch('/api/state').then(r=>r.json()).then(render).catch(()=>{$('error').textContent='Start the SignalCrew server and refresh.';});
