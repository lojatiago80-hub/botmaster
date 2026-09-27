require('dotenv').config();
const express=require('express');const session=require('express-session');const PgSession=require('connect-pg-simple')(session);const path=require('path');const db=require('./database');const agent=require('./agentClient');
const {encryptBackup,decryptBackup}=require('./backupCrypto');
const app=express();const PORT=Number(process.env.PORT||10000);
// Render termina o HTTPS no proxy. Sem trust proxy, cookies 'secure' podem não ser gravados.
app.set('trust proxy',1);
app.use(express.json({limit:'10mb'}));app.use(express.urlencoded({extended:true}));

function sessionDatabaseUrl(raw){
  if(!raw)return '';
  try{
    const u=new URL(raw);
    u.searchParams.delete('sslmode');
    u.searchParams.delete('uselibpqcompat');
    return u.toString();
  }catch{
    return raw;
  }
}
const SESSION_DATABASE_URL=sessionDatabaseUrl(process.env.DATABASE_URL);
app.use(session({
  store:new PgSession({
    conString:SESSION_DATABASE_URL,
    createTableIfMissing:true,
    tableName:'user_sessions',
    ssl:SESSION_DATABASE_URL&&/localhost|127\.0\.0\.1/.test(SESSION_DATABASE_URL)?false:{rejectUnauthorized:false}
  }),
  secret:process.env.SESSION_SECRET||'troque-essa-chave',
  resave:false,
  saveUninitialized:false,
  proxy:true,
  cookie:{
    httpOnly:true,
    sameSite:'lax',
    secure:process.env.NODE_ENV==='production',
    maxAge:1000*60*60*24*7
  }
}));
// Ao abrir a página pública do Master, acorda em segundo plano os Agents
// que estão cadastrados como desejados online. Não expõe comandos administrativos.
let lastPublicWake = 0;
async function wakeDesiredAgents(){
  const now = Date.now();
  // Evita disparar vários wake-ups seguidos caso a página seja atualizada repetidamente.
  if (now - lastPublicWake < 15000) return;
  lastPublicWake = now;
  try {
    const bots = await db.list();
    const targets=[]; for(const b of bots){if(!b.desiredOnline)continue;try{const full=await db.get(b.id,true);if(full.agentUrl)targets.push(full)}catch{}}
    for (const b of targets) {
      // Não aguardamos o resultado: só precisamos gerar uma requisição de entrada
      // no serviço Free do Render para que ele acorde.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      fetch(String(b.agentUrl).replace(/\/$/, '') + '/health', {
        method: 'GET',
        signal: controller.signal
      }).catch(() => {}).finally(() => clearTimeout(timer));
    }
    if (targets.length) console.log(`Wake público: ${targets.length} Agent(s) acionado(s).`);
  } catch (e) {
    console.warn('Wake público falhou:', e.message);
  }
}

// IMPORTANTE: este middleware vem ANTES do express.static.
// Assim, visitar / já dispara o wake mesmo quando index.html é servido como arquivo estático.
app.use((req,res,next)=>{
  if(req.method==='GET' && (req.path==='/' || req.path==='/index.html')){
    wakeDesiredAgents().catch(()=>{});
  }
  next();
});

app.use(express.static(path.join(__dirname,'public')));
function auth(req,res,next){if(req.session.ok)return next();res.status(401).json({ok:false,error:'Não autenticado'});}function fail(res,e,code=500){res.status(code).json({ok:false,error:e.message||String(e)})}
app.get('/',(_q,r)=>r.sendFile(path.join(__dirname,'public/index.html')));
app.post('/api/login',(req,res)=>{if(String(req.body.password||'')===String(process.env.ADMIN_PASSWORD||'admin123')){req.session.ok=true;return res.json({ok:true})}res.status(403).json({ok:false,error:'Senha incorreta'})});
app.post('/api/logout',(q,r)=>q.session.destroy(()=>r.json({ok:true})));
app.get('/api/me',auth,(q,r)=>r.json({ok:true}));
app.get('/api/bots',auth,async(q,r)=>{try{const bots=await db.list();for(const b of bots){try{const full=await db.get(b.id,true);const s=await agent.call(full,'/status');b.live=s.status||s;}catch(e){b.live={reachable:false,phase:'unreachable',error:e.message}}}r.json({ok:true,bots})}catch(e){fail(r,e)}});
app.post('/api/bots',auth,async(req,res)=>{try{const b=await db.create(req.body);res.json({ok:true,bot:b})}catch(e){fail(res,e,400)}});
app.get('/api/bots/:id',auth,async(req,res)=>{try{const b=await db.get(req.params.id);if(!b)return fail(res,new Error('Bot não encontrado'),404);res.json({ok:true,bot:b})}catch(e){fail(res,e)}});
app.put('/api/bots/:id',auth,async(req,res)=>{try{res.json({ok:true,bot:await db.update(req.params.id,req.body)})}catch(e){fail(res,e,400)}});
app.delete('/api/bots/:id',auth,async(req,res)=>{try{const b=await db.get(req.params.id,true);if(b){try{await agent.call(b,'/stop','POST')}catch{}}await db.del(req.params.id);res.json({ok:true})}catch(e){fail(res,e)}});

async function probeUrl(url,timeoutMs=9000){
  if(!url)return false;
  const controller=new AbortController(); const timer=setTimeout(()=>controller.abort(),timeoutMs);
  try{const r=await fetch(String(url).replace(/\/$/,'')+'/health',{signal:controller.signal,cache:'no-store'});return r.ok}catch{return false}finally{clearTimeout(timer)}
}
async function refreshAgents(waitBetween=true){
  const all=(await db.listAgents()).filter(a=>a.approved);
  const pending=new Map(all.map(a=>[a.id,a]));
  const delays=waitBetween?[0,8000,8000]:[0];
  for(let round=0;round<delays.length && pending.size;round++){
    if(delays[round])await new Promise(r=>setTimeout(r,delays[round]));
    const batch=[...pending.values()];
    await Promise.all(batch.map(async a=>{
      if(!a.agentUrl){await db.setAgentCheck(a.id,'no_url');pending.delete(a.id);return}
      const ok=await probeUrl(a.agentUrl,5000);
      if(ok){await db.setAgentCheck(a.id,'online',{masterCheckAttempt:round+1});pending.delete(a.id)}
      else if(round<delays.length-1)await db.setAgentCheck(a.id,'waking',{masterCheckAttempt:round+1});
      else await db.setAgentCheck(a.id,'offline',{masterCheckAttempt:round+1});
    }));
  }
  return db.listAgents();
}
async function ensureAgentForBot(botId){
  let b=await db.get(botId,true); if(!b)throw new Error('Bot não encontrado');
  if(b.agentId){const a=await db.getAgent(b.agentId);if(a&&a.approved&&await probeUrl(a.agent_url,9000)){await db.setAgentCheck(a.id,'online');return b}await db.assignAgent(botId,null);}
  await refreshAgents(true);
  const free=await db.firstFreeOnlineAgent();
  if(!free)throw new Error('Nenhum servidor disponível respondeu. Abra Servidores e use Atualizar para conferir os Agents.');
  await db.assignAgent(botId,free.id); return db.get(botId,true);
}
async function botAction(req,res,act){
  try{
    let b=await db.get(req.params.id,true);
    if(!b)return fail(res,new Error('Bot não encontrado'),404);
    if(act==='start'){
      b=await ensureAgentForBot(b.id);
      await db.desired(b.id,true);
      const x=await agent.call(b,'/start','POST',{config:b});
      return res.json({...x,agentName:b.agentName||''});
    }
    if(act==='stop'){
      await db.desired(b.id,false);
      let x={ok:true,message:'Bot já estava desligado.'};
      if(b.agentId){
        try{x=await agent.call(b,'/stop','POST')}
        catch(e){x={ok:true,message:'Bot marcado como desligado; servidor não respondeu.'}}
      }
      await db.freeAgentForBot(b.id);
      return res.json({...x,message:(x.message||'Bot desligado.')+' Servidor liberado para outro avatar.'});
    }
    if(act==='restart'){
      await db.desired(b.id,true);
      return res.json(await agent.call(b,'/restart','POST',{config:b}));
    }
    if(act==='home')return res.json(await agent.call(b,'/home','POST'));
    if(act==='invite')return res.json(await agent.call(b,'/invite','POST',req.body||{}));
  }catch(e){fail(res,e,503)}
}
for(const a of ['start','stop','restart','home','invite'])app.post(`/api/bots/:id/${a}`,auth,(q,r)=>botAction(q,r,a));
app.get('/api/bots/:id/logs',auth,async(req,res)=>{try{const b=await db.get(req.params.id,true);let live=[];try{const x=await agent.call(b,'/logs');live=x.logs||[]}catch{}const stored=await db.logs(b.id);res.json({ok:true,logs:live.length?live:stored})}catch(e){fail(res,e)}});
// Pool de Agents: o Agent se apresenta sozinho; o dono aprova e atribui um bot no painel.
app.post('/api/agents/register',async(req,res)=>{try{const a=await db.registerAgent(req.body||{});const runtime=await db.agentRuntime(a.agent_key);res.json({ok:true,approved:!!a.approved,agentId:Number(a.id),agentSecret:runtime?.agentSecret||'',botId:runtime?.botId||0,desiredOnline:!!runtime?.desiredOnline,config:runtime?.config||null})}catch(e){fail(res,e,400)}});
app.get('/api/agents',auth,async(req,res)=>{try{res.json({ok:true,agents:await db.listAgents()})}catch(e){fail(res,e)}});
app.post('/api/agents/refresh',auth,async(req,res)=>{try{res.json({ok:true,agents:await refreshAgents(true)})}catch(e){fail(res,e,500)}});
app.put('/api/agents/:id',auth,async(req,res)=>{try{res.json({ok:true,agent:await db.updateAgent(req.params.id,req.body||{})})}catch(e){fail(res,e,400)}});
app.post('/api/agents/:id/approve',auth,async(req,res)=>{try{res.json({ok:true,agent:await db.approveAgent(req.params.id,req.body?.name||'')})}catch(e){fail(res,e,400)}});
app.delete('/api/agents/:id',auth,async(req,res)=>{try{await db.deleteAgent(req.params.id);res.json({ok:true})}catch(e){fail(res,e,400)}});
app.post('/api/bots/:id/assign',auth,async(req,res)=>{try{await db.assignAgent(req.params.id,req.body?.agentId||null);res.json({ok:true,bot:await db.get(req.params.id)})}catch(e){fail(res,e,400)}});

// Agent usa esta rota para recuperar a configuração após restart do Render.
app.post('/api/agent/bootstrap',async(req,res)=>{try{const requestedId=Number(req.body.botId||0),secret=String(req.body.agentSecret||'');if(!secret)return fail(res,new Error('agentSecret ausente'),400);const b=requestedId?await db.get(requestedId,true):await db.findByAgentSecret(secret);if(!b||b.agentSecret!==secret)return fail(res,new Error('Agent não autorizado'),403);await db.heartbeat(b.id,req.body.status||{});res.json({ok:true,botId:b.id,desiredOnline:b.desiredOnline,config:b})}catch(e){fail(res,e)}});
app.post('/api/agent/heartbeat',async(req,res)=>{try{const requestedId=Number(req.body.botId||0),secret=String(req.body.agentSecret||''),agentKey=String(req.body.agentKey||'');let b=null;if(agentKey){const ar=await db.agentRuntime(agentKey);if(!ar||!ar.approved||ar.agentSecret!==secret||Number(ar.botId||0)!==requestedId)return fail(res,new Error('Agent não autorizado'),403);b=ar.config;}else{b=requestedId?await db.get(requestedId,true):await db.findByAgentSecret(secret);if(!b||b.agentSecret!==secret)return fail(res,new Error('Agent não autorizado'),403);}await db.heartbeat(b.id,req.body.status||{});if(req.body.log)await db.log(b.id,req.body.log);res.json({ok:true,botId:b.id,desiredOnline:b.desiredOnline})}catch(e){fail(res,e)}});

app.get('/api/system/stats',auth,async(req,res)=>{try{res.json({ok:true,stats:await db.stats()})}catch(e){fail(res,e)}});
app.post('/api/system/cleanup',auth,async(req,res)=>{try{res.json({ok:true,...await db.cleanupLogs(req.body?.days||30)})}catch(e){fail(res,e)}});
app.post('/api/system/backup',auth,async(req,res)=>{try{const data=await db.exportBackup();const pkg=encryptBackup(data,req.body?.password);const name=`sl-bot-backup-${new Date().toISOString().slice(0,10)}.slbackup`;res.setHeader('Content-Type','application/octet-stream');res.setHeader('Content-Disposition',`attachment; filename="${name}"`);res.send(JSON.stringify(pkg))}catch(e){fail(res,e,400)}});
app.post('/api/system/restore',auth,async(req,res)=>{try{const data=decryptBackup(req.body?.backup,req.body?.password);const out=await db.restoreBackup(data);res.json({ok:true,...out})}catch(e){fail(res,new Error('Não foi possível restaurar: '+(e.message||e)),400)}});
app.get('/health',(_q,r)=>r.send('ok'));
db.init().then(()=>{setInterval(()=>db.cleanupLogs(Number(process.env.LOG_RETENTION_DAYS||30)).catch(e=>console.warn('Limpeza de logs:',e.message)),6*60*60*1000);return app.listen(PORT,'0.0.0.0',()=>console.log('Master Panel ativo na porta',PORT))}).catch(e=>{console.error(e);process.exit(1)});
