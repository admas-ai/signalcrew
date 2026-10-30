import { createHash, randomUUID } from 'node:crypto';

export const ACTIONS = ['scan', 'shield', 'boost'];
const WEATHER = [
  {name:'Debris corridor', hint:'Shields protect the hull. Boost through the gap.', damage:18},
  {name:'Signal fog', hint:'Scanning finds the safe route. Keep your engines fed.', damage:14},
  {name:'Solar crosswind', hint:'A balanced crew can ride the current.', damage:20},
  {name:'Silent relay', hint:'The beacon is close. Scan before the last jump.', damage:14},
  {name:'Final approach', hint:'One coordinated push brings the relay home.', damage:22}
];
export function parseCommand(text) {
  if (typeof text !== 'string') return null;
  return text.trim().toLowerCase().match(/^!crew\s+(scan|shield|boost)$/)?.[1] || null;
}
export class Mission {
  constructor({now=Date.now, roundSeconds=30}={}) {
    this.now=now; this.roundMs=roundSeconds*1000; this.reset('rehearsal');
  }
  reset(mode=this.mode) {
    if (!['rehearsal','live'].includes(mode)) throw new Error('Unknown mission mode');
    this.mode=mode; this.id=randomUUID(); this.phase='ready'; this.round=0;
    this.hull=100; this.energy=65; this.signal=0; this.distance=0;
    this.receipts=[]; this.deadline=null; this.remainingMs=null; this.pauseReason='';
    this.votes=new Map(); this.seen=new Map(); this.counts={scan:0,shield:0,boost:0};
  }
  startRound() {
    if (!['ready','debrief'].includes(this.phase)) throw new Error('Finish or resume the current round first');
    if(this.round>=5 || this.hull<=0) throw new Error('Reset before starting a new mission');
    this.round++; this.phase='collecting'; this.deadline=this.now()+this.roundMs;
    this.remainingMs=null; this.votes.clear(); this.counts={scan:0,shield:0,boost:0};
  }
  contribute({userId,messageId,text,timestamp=this.now()}) {
    const action=parseCommand(text);
    if(!action || this.phase!=='collecting' || this.now()>=this.deadline) return false;
    if(typeof userId!=='string'||!userId||typeof messageId!=='string'||!messageId) return false;
    // Bound delayed/replayed deliveries to this round and tolerate clock skew.
    if(!Number.isFinite(timestamp)||timestamp<this.deadline-this.roundMs-2000||timestamp>this.now()+5000) return false;
    if(this.seen.has(messageId)) return false;
    this.seen.set(messageId,this.now());
    if(this.seen.size>10000) this.seen.delete(this.seen.keys().next().value);
    const voter=createHash('sha256').update(this.id+':'+userId).digest('hex');
    if(this.votes.has(voter)||this.votes.size>=10000) return false;
    this.votes.set(voter,action); this.counts[action]++; return true;
  }
  pause(reason='Paused by the captain') {
    if(this.phase!=='collecting') return;
    this.remainingMs=Math.max(0,this.deadline-this.now());
    this.deadline=null; this.phase='paused'; this.pauseReason=reason;
  }
  resume() {
    if(this.phase!=='paused') throw new Error('No paused round');
    this.deadline=this.now()+this.remainingMs; this.phase='collecting'; this.pauseReason='';
  }
  resolve() {
    if(this.phase!=='collecting') throw new Error('No open round');
    const total=this.votes.size, ratio=a=>total?this.counts[a]/total:0;
    const damage=Math.max(0,WEATHER[this.round-1].damage-Math.round(ratio('shield')*42));
    const gain=Math.round(ratio('boost')*90);
    const scan=Math.round(ratio('scan')*90);
    const cost=Math.round(ratio('boost')*24);
    const before={hull:this.hull,energy:this.energy,signal:this.signal,distance:this.distance};
    this.hull=Math.max(0,this.hull-damage);
    this.distance+=Math.round(gain*(this.energy>=cost?1:0.4));
    this.energy=Math.min(100,Math.max(0,this.energy-cost+Math.round(ratio('scan')*20)));
    this.signal=Math.min(100,this.signal+scan);
    this.receipts.push({round:this.round,source:this.mode==='live'?'Twitch EventSub':'Synthetic rehearsal',
      participants:total,actions:{...this.counts},before,
      after:{hull:this.hull,energy:this.energy,signal:this.signal,distance:this.distance}});
    this.phase=this.hull<=0?'lost':this.round===5?(this.distance>=135&&this.signal>=70?'rescued':'lost'):'debrief';
    this.deadline=null; this.votes.clear();
  }
  tick() {if(this.phase==='collecting'&&this.now()>=this.deadline){this.resolve();return true;}return false;}
  snapshot() {
    return {id:this.id,mode:this.mode,phase:this.phase,round:this.round,totalRounds:5,
      hull:this.hull,energy:this.energy,signal:this.signal,distance:this.distance,
      goal:{distance:135,signal:70},deadline:this.deadline,serverNow:this.now(),
      remainingMs:this.remainingMs,pauseReason:this.pauseReason,counts:{...this.counts},
      participants:Object.values(this.counts).reduce((a,b)=>a+b,0),
      weather:WEATHER[Math.max(0,this.round-1)],receipts:structuredClone(this.receipts)};
  }
}
