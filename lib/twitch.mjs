const WS_URL='wss://eventsub.wss.twitch.tv/ws';
const SCOPE='user:read:chat';
export class TwitchClient {
  constructor({clientId='',fetchImpl=fetch,WebSocketImpl=WebSocket,onChat=()=>{},onStatus=()=>{},now=Date.now}={}) {
    this.clientId=clientId;this.fetch=fetchImpl;this.WS=WebSocketImpl;this.onChat=onChat;
    this.onStatus=onStatus;this.now=now;this.state={status:'disconnected',channel:'',detail:'Connect your Twitch channel'};
    this.tokens=null;this.device=null;this.socket=null;this.replacement=null;this.stopped=true;
    this.lastValidation=0;this.refreshing=null;this.polling=null;this.retries=0;this.seen=new Map();this.generation=0;
  }
  status(){return {...this.state,configured:!!this.clientId};}
  setStatus(status,detail){this.state={...this.state,status,detail};this.onStatus(this.status());}
  async request(url,options={}) {
    const res=await this.fetch(url,{...options,signal:AbortSignal.timeout(10000)});
    const data=await res.json();return {res,data};
  }
  async form(url,body) {
    return this.request(url,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams(body)});
  }
  async startDevice() {
    if(!this.clientId) throw new Error('Set TWITCH_CLIENT_ID in .env first');
    this.disconnect();const generation=this.generation;
    const {res,data}=await this.form('https://id.twitch.tv/oauth2/device',{client_id:this.clientId,scopes:SCOPE});
    if(generation!==this.generation)throw new Error('Authorization cancelled');
    if(!res.ok||!data.device_code||!data.verification_uri||!data.user_code) throw new Error('Twitch device authorization could not start');
    const uri=new URL(data.verification_uri);
    if(uri.origin!=='https://www.twitch.tv'||uri.pathname!=='/activate') throw new Error('Unexpected authorization destination');
    this.device={code:data.device_code,expires:this.now()+Math.min(data.expires_in,1800)*1000,
      interval:Math.max(5,data.interval||5)*1000,nextPoll:this.now()+Math.max(5,data.interval||5)*1000};
    this.setStatus('authorizing','Approve read-only chat access on Twitch');
    return {verificationUri:uri.href,userCode:data.user_code,expiresIn:data.expires_in};
  }
  async pollDevice() {
    if(this.polling) return this.polling;
    this.polling=this.pollDeviceOnce().finally(()=>{this.polling=null;});return this.polling;
  }
  async pollDeviceOnce() {
    const d=this.device;
    if(!d) return {status:this.state.status};
    if(this.now()>=d.expires){this.device=null;this.setStatus('disconnected','Authorization expired; connect again');return {status:'expired'};}
    if(this.now()<d.nextPoll)return {status:'pending'};
    d.nextPoll=this.now()+d.interval;
    const {res,data}=await this.form('https://id.twitch.tv/oauth2/token',{
      client_id:this.clientId,scopes:SCOPE,device_code:d.code,grant_type:'urn:ietf:params:oauth:grant-type:device_code'});
    if(this.device!==d)return {status:'cancelled'};
    if(!res.ok){
      const error=data.message||data.error;
      if(error==='authorization_pending')return {status:'pending'};
      if(error==='slow_down'){d.interval+=5000;d.nextPoll=this.now()+d.interval;return {status:'pending'};}
      this.device=null;this.setStatus('disconnected','Authorization declined or expired; connect again');
      return {status:'denied'};
    }
    if(!data.access_token||!data.refresh_token)throw new Error('Incomplete Twitch token response');
    this.tokens={access:data.access_token,refresh:data.refresh_token,expires:this.now()+data.expires_in*1000};
    this.userId=null;this.lastValidation=0;this.device=null;
    try{await this.connect();}catch{this.setStatus('error','Twitch identity or connection failed; authorize again');throw new Error('Twitch connection failed');}
    return {status:this.state.status};
  }
  async ensureToken() {
    const identityGeneration=this.generation;
    if(!this.tokens)throw new Error('Connect with Twitch first');
    if(this.tokens.expires-this.now()<60000){
      if(!this.refreshing)this.refreshing=(async()=>{
        const generation=this.generation;
        const {res,data}=await this.form('https://id.twitch.tv/oauth2/token',{
          grant_type:'refresh_token',client_id:this.clientId,refresh_token:this.tokens.refresh});
        if(generation!==this.generation)throw new Error('Authorization cancelled');
        if(!res.ok||!data.access_token||!data.refresh_token){this.tokens=null;throw new Error('Reconnect with Twitch; refresh failed');}
        this.tokens={access:data.access_token,refresh:data.refresh_token,expires:this.now()+data.expires_in*1000};
      })().finally(()=>{this.refreshing=null;});
      await this.refreshing;
    }
    if(!this.userId||this.now()-this.lastValidation>=3600000){
      const {res,data}=await this.request('https://id.twitch.tv/oauth2/validate',{headers:{Authorization:'OAuth '+this.tokens.access}});
      if(identityGeneration!==this.generation||!this.tokens)throw new Error('Authorization cancelled');
      if(!res.ok||data.client_id!==this.clientId||!data.scopes?.includes(SCOPE)||!data.user_id){
        this.tokens=null;throw new Error('Twitch identity or read-chat permission is invalid');
      }
      this.userId=data.user_id;this.state.channel=data.login||data.user_id;this.lastValidation=this.now();
    }
    return this.tokens.access;
  }
  async connect() {
    const generation=this.generation;await this.ensureToken();if(generation!==this.generation)return;
    this.stopped=false;this.retries=0;
    this.closeSockets();this.setStatus('connecting','Opening Twitch EventSub');this.openSocket(WS_URL,false);
  }
  openSocket(url,migrating) {
    const socketGeneration=this.generation;
    const parsed=new URL(url);
    if(parsed.protocol!=='wss:'||parsed.hostname!=='eventsub.wss.twitch.tv'||(parsed.port&&parsed.port!=='443')){
      this.setStatus('error','Unexpected Twitch reconnect destination');return;
    }
    const ws=new this.WS(url);
    if(migrating)this.replacement=ws;else this.socket=ws;
    let timeout=null;
    const arm=seconds=>{clearTimeout(timeout);timeout=setTimeout(()=>{ws.close();},(seconds+2)*1000);timeout.unref?.();};
    let keepalive=10;arm(keepalive);
    ws.addEventListener('message',async ev=>{
      if(this.stopped||socketGeneration!==this.generation||(ws!==this.socket&&ws!==this.replacement))return;
      try {
        const m=JSON.parse(String(ev.data));const type=m.metadata?.message_type;
        if(type==='session_welcome'){
          keepalive=m.payload.session.keepalive_timeout_seconds||10;arm(keepalive);
          if(migrating){const old=this.socket;this.socket=ws;this.replacement=null;old?.close();}
          else{
            const token=await this.ensureToken();
            const {res,data}=await this.request('https://api.twitch.tv/helix/eventsub/subscriptions',{
              method:'POST',headers:{Authorization:'Bearer '+token,'Client-Id':this.clientId,'Content-Type':'application/json'},
              body:JSON.stringify({type:'channel.chat.message',version:'1',condition:{broadcaster_user_id:this.userId,user_id:this.userId},transport:{method:'websocket',session_id:m.payload.session.id}})});
            if(res.status!==202||data.data?.[0]?.status!=='enabled')throw new Error('Twitch chat subscription was not enabled');
          }
          if(this.stopped||socketGeneration!==this.generation||ws!==this.socket)return;
          this.retries=0;this.setStatus('connected','Receiving chat from #'+this.state.channel);
        }else if(type==='session_keepalive'){arm(keepalive);}
        else if(type==='session_reconnect'){this.openSocket(m.payload.session.reconnect_url,true);}
        else if(type==='revocation'){
          this.disconnect();this.setStatus('revoked','Twitch revoked chat access; authorize again');
        }else if(type==='notification'){
          arm(keepalive);
          const e=m.payload?.event,id=m.metadata?.message_id;
          if(m.metadata?.subscription_type!=='channel.chat.message'||e?.broadcaster_user_id!==this.userId||!id||this.seen.has(id))return;
          this.seen.set(id,true);if(this.seen.size>10000)this.seen.delete(this.seen.keys().next().value);
          this.onChat({userId:e.chatter_user_id,messageId:e.message_id||id,text:e.message?.text,timestamp:Date.parse(m.metadata.message_timestamp)});
        }
      }catch{this.setStatus('error','Twitch connection failed; retry or reconnect');ws.close();}
    });
    ws.addEventListener('error',()=>ws.close());
    ws.addEventListener('close',()=>{
      clearTimeout(timeout);
      if(this.stopped)return;
      if(ws===this.replacement){this.replacement=null;return;}
      if(ws!==this.socket)return;
      this.setStatus('disconnected','Chat interrupted; mission paused. Reconnect, then resume.');
      if(this.retries++<5){clearTimeout(this.retryTimer);this.retryTimer=setTimeout(()=>{this.connectAfterLoss();},Math.min(30000,1000*2**this.retries));this.retryTimer.unref?.();}
    });
  }
  async connectAfterLoss(){if(this.stopped)return;try{await this.ensureToken();this.openSocket(WS_URL,false);}catch{this.setStatus('error','Twitch authorization needs reconnecting');}}
  closeSockets(){clearTimeout(this.retryTimer);const old=this.socket,other=this.replacement;this.socket=null;this.replacement=null;old?.close();other?.close();}
  disconnect(){this.generation++;this.stopped=true;this.closeSockets();this.device=null;this.tokens=null;this.userId=null;this.lastValidation=0;this.setStatus('disconnected','Disconnected; tokens removed from memory');}
}
