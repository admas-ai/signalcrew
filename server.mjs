import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {randomBytes,timingSafeEqual} from 'node:crypto';
import {Mission} from './lib/mission.mjs';
import {TwitchClient} from './lib/twitch.mjs';

export function createApp({clientId=process.env.TWITCH_CLIENT_ID||'',mission=new Mission(),twitchOptions={}}={}){
  const key=randomBytes(32).toString('base64url'),subscribers=new Set();
  let rehearsalSequence=0;
  const twitch=new TwitchClient({clientId,...twitchOptions,
    onChat:e=>{if(mission.mode==='live'&&twitch.status().status==='connected'&&mission.contribute(e))broadcast();},
    onStatus:s=>{if(mission.mode==='live'&&s.status!=='connected')mission.pause('Twitch chat interrupted. Reconnect and resume this round.');broadcast();}});
  function snapshot(){return {mission:mission.snapshot(),twitch:twitch.status(),proof:{genuineTwitchTestRecorded:false,note:'Connection status is runtime state, not a contest submission receipt.'}};}
  function broadcast(){const data='data: '+JSON.stringify(snapshot())+'\n\n';for(const res of subscribers){if(res.writableLength>65536){res.end();subscribers.delete(res);}else res.write(data);}}
  function json(res,status,data){res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(data));}
  function controlAllowed(req,origin){
    const given=req.headers['x-control-key'];
    return req.headers.origin===origin&&typeof given==='string'&&given.length===key.length&&timingSafeEqual(Buffer.from(given),Buffer.from(key));
  }
  async function body(req){
    if(!req.headers['content-type']?.startsWith('application/json'))throw new Error('Use JSON');
    let text='',size=0;for await(const part of req){size+=part.length;if(size>8192)throw new Error('Request too large');text+=part;}
    const data=JSON.parse(text||'{}');if(!data||typeof data!=='object'||Array.isArray(data))throw new Error('Invalid request');return data;
  }
  const server=http.createServer(async(req,res)=>{
    const address=server.address(),host=req.headers.host||'';
    if(!['localhost:'+address.port,'127.0.0.1:'+address.port].includes(host))return json(res,403,{error:'Local access only'});
    const origin='http://'+host,url=new URL(req.url,origin);
    res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'");
    try{
      if(req.method==='GET'&&url.pathname==='/api/state')return json(res,200,snapshot());
      if(req.method==='GET'&&url.pathname==='/api/evidence')return json(res,200,{project:'SignalCrew',exportedAt:new Date().toISOString(),...snapshot()});
      if(req.method==='GET'&&url.pathname==='/api/events'){
        if(subscribers.size>=32)return json(res,429,{error:'Too many display connections'});
        res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-store','Connection':'keep-alive'});
        subscribers.add(res);res.write('data: '+JSON.stringify(snapshot())+'\n\n');
        req.on('close',()=>subscribers.delete(res));return;
      }
      if(req.method==='POST'&&url.pathname.startsWith('/api/')){
        if(!controlAllowed(req,origin))return json(res,403,{error:'Use this computer’s captain console'});
        const data=await body(req);
        if(url.pathname==='/api/auth/start')return json(res,200,await twitch.startDevice());
        if(url.pathname==='/api/auth/poll')return json(res,200,await twitch.pollDevice());
        if(url.pathname==='/api/auth/retry'){await twitch.connect();return json(res,200,twitch.status());}
        if(url.pathname==='/api/auth/disconnect'){twitch.disconnect();return json(res,200,twitch.status());}
        if(url.pathname==='/api/control'){
          const {action}=data;
          if(action==='reset')mission.reset(data.mode||mission.mode);
          else if(action==='start'){
            if(mission.mode==='live'&&twitch.status().status!=='connected')throw new Error('Connect Twitch before starting a live round');
            mission.startRound();
          }else if(action==='pause')mission.pause();
          else if(action==='resume'){
            if(mission.mode==='live'&&twitch.status().status!=='connected')throw new Error('Reconnect Twitch first');
            mission.resume();
          }else if(action==='resolve')mission.resolve();
          else throw new Error('Unknown captain action');
          broadcast();return json(res,200,snapshot());
        }
        if(url.pathname==='/api/rehearsal'){
          if(mission.mode!=='rehearsal')return json(res,409,{error:'Synthetic commands are disabled in live mode'});
          if(!['scan','shield','boost'].includes(data.action))throw new Error('Choose a crew action');
          const n=++rehearsalSequence;
          const accepted=mission.contribute({userId:'rehearsal-'+n,messageId:'rehearsal-'+n,text:'!crew '+data.action});
          broadcast();return json(res,200,{accepted});
        }
        return json(res,404,{error:'Route not found'});
      }
      const files={'/':['index.html','text/html'],'/overlay':['index.html','text/html'],'/app.js':['app.js','text/javascript'],'/style.css':['style.css','text/css']};
      const entry=files[url.pathname];
      if(req.method!=='GET'||!entry)return json(res,404,{error:'Route not found'});
      let bytes=await readFile(new URL('./public/'+entry[0],import.meta.url));
      if(entry[0]==='index.html')bytes=bytes.toString().replace('__CONTROL_KEY__',url.pathname==='/overlay'?'':key);
      res.writeHead(200,{'Content-Type':entry[1],'Cache-Control':'no-store'});res.end(bytes);
    }catch{json(res,400,{error:'Action failed. Check configuration, connection, and current mission phase.'});}
  });
  const clock=setInterval(()=>{if(mission.tick())broadcast();},250);clock.unref();
  const heartbeat=setInterval(()=>{for(const res of subscribers)res.write(': heartbeat\n\n');},15000);heartbeat.unref();
  const validation=setInterval(()=>{if(twitch.tokens)twitch.ensureToken().catch(()=>twitch.disconnect());},3600000);validation.unref();
  return {server,mission,twitch,snapshot,close:async()=>{clearInterval(clock);clearInterval(heartbeat);clearInterval(validation);twitch.disconnect();for(const res of subscribers)res.end();await new Promise(r=>server.close(r));}};
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
  const port=Number(process.env.PORT||4310);
  if(!Number.isInteger(port)||port<1024||port>65535)throw new Error('PORT must be1024..65535');
  const app=createApp();app.server.listen(port,'127.0.0.1',()=>console.log(`SignalCrew captain console: http://localhost:${port}\nOBS display: http://localhost:${port}/overlay\nStarts in synthetic rehearsal. Live Twitch proof still requires a real channel test.`));
  for(const sig of ['SIGINT','SIGTERM'])process.on(sig,()=>app.close().then(()=>process.exit(0)));
}
