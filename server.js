require('dotenv').config();
const express=require('express');const session=require('express-session');const PgSession=require('connect-pg-simple')(session);const path=require('path');const db=require('./database');const agent=require('./agentClient');const render=require('./renderClient');
const app=express();const PORT=Number(process.env.PORT||10000);
// Render termina o HTTPS no proxy. Sem trust proxy, cookies 'secure' podem não ser gravados.
app.set('trust proxy',1);
app.use(express.json({limit:'1mb'}));app.use(express.urlencoded({extended:true}));
app.use(session({
  store:new PgSession({
    conString:process.env.DATABASE_URL,
    createTableIfMissing:true,
    tableName:'user_sessions',
    ssl:process.env.DATABASE_URL&&/localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL)?false:{rejectUnauthorized:false}
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
app.use(express.static(path.join(__dirname,'public')));
function auth(req,res,next){if(req.session.ok)return next();res.status(401).json({ok:false,error:'Não autenticado'});}function fail(res,e,code=500){res.status(code).json({ok:false,error:e.message||String(e)})}
app.get('/',(_q,r)=>r.sendFile(path.join(__dirname,'public/index.html')));
app.post('/api/login',(req,res)=>{if(String(req.body.password||'')===String(process.env.ADMIN_PASSWORD||'admin123')){req.session.ok=true;return res.json({ok:true})}res.status(403).json({ok:false,error:'Senha incorreta'})});
app.post('/api/logout',(q,r)=>q.session.destroy(()=>r.json({ok:true})));
app.get('/api/me',auth,(q,r)=>r.json({ok:true}));
app.get('/api/bots',auth,async(q,r)=>{try{const bots=await db.list();for(const b of bots){try{const full=await db.get(b.id,true);const s=await agent.call(full,'/status');b.live=s.status||s;}catch(e){b.live={reachable:false,phase:'unreachable',error:e.message}}}r.json({ok:true,bots})}catch(e){fail(r,e)}});
app.post('/api/bots',auth,async(req,res)=>{try{if(!req.body.agentUrl||!req.body.agentSecret)return fail(res,new Error('Informe Agent URL e Agent Secret.'),400);const b=await db.create(req.body);res.json({ok:true,bot:b})}catch(e){fail(res,e,400)}});
app.get('/api/bots/:id',auth,async(req,res)=>{try{const b=await db.get(req.params.id);if(!b)return fail(res,new Error('Bot não encontrado'),404);res.json({ok:true,bot:b})}catch(e){fail(res,e)}});
app.put('/api/bots/:id',auth,async(req,res)=>{try{res.json({ok:true,bot:await db.update(req.params.id,req.body)})}catch(e){fail(res,e,400)}});
app.delete('/api/bots/:id',auth,async(req,res)=>{try{const b=await db.get(req.params.id,true);if(b){try{await agent.call(b,'/stop','POST')}catch{}}await db.del(req.params.id);res.json({ok:true})}catch(e){fail(res,e)}});
async function botAction(req,res,act){try{const b=await db.get(req.params.id,true);if(!b)return fail(res,new Error('Bot não encontrado'),404);if(act==='start'){await db.desired(b.id,true);const x=await agent.call(b,'/start','POST',{config:b});return res.json(x)}if(act==='stop'){await db.desired(b.id,false);return res.json(await agent.call(b,'/stop','POST'))}if(act==='restart'){await db.desired(b.id,true);return res.json(await agent.call(b,'/restart','POST',{config:b}))}if(act==='home')return res.json(await agent.call(b,'/home','POST'));if(act==='invite')return res.json(await agent.call(b,'/invite','POST',req.body||{}));}catch(e){fail(res,e,503)}}
for(const a of ['start','stop','restart','home','invite'])app.post(`/api/bots/:id/${a}`,auth,(q,r)=>botAction(q,r,a));
app.get('/api/bots/:id/logs',auth,async(req,res)=>{try{const b=await db.get(req.params.id,true);let live=[];try{const x=await agent.call(b,'/logs');live=x.logs||[]}catch{}const stored=await db.logs(b.id);res.json({ok:true,logs:live.length?live:stored})}catch(e){fail(res,e)}});
for(const a of ['restart','suspend','resume','deploy'])app.post(`/api/bots/:id/render/${a}`,auth,async(req,res)=>{try{const b=await db.get(req.params.id,true);const data=await render[a](b);res.json({ok:true,data})}catch(e){fail(res,e,400)}});
// Agent usa esta rota para recuperar a configuração após restart do Render.
app.post('/api/agent/bootstrap',async(req,res)=>{try{const requestedId=Number(req.body.botId||0),secret=String(req.body.agentSecret||'');if(!secret)return fail(res,new Error('agentSecret ausente'),400);const b=requestedId?await db.get(requestedId,true):await db.findByAgentSecret(secret);if(!b||b.agentSecret!==secret)return fail(res,new Error('Agent não autorizado'),403);await db.heartbeat(b.id,req.body.status||{});res.json({ok:true,botId:b.id,desiredOnline:b.desiredOnline,config:b})}catch(e){fail(res,e)}});
app.post('/api/agent/heartbeat',async(req,res)=>{try{const requestedId=Number(req.body.botId||0),secret=String(req.body.agentSecret||'');const b=requestedId?await db.get(requestedId,true):await db.findByAgentSecret(secret);if(!b||b.agentSecret!==secret)return fail(res,new Error('Agent não autorizado'),403);await db.heartbeat(b.id,req.body.status||{});if(req.body.log)await db.log(b.id,req.body.log);res.json({ok:true,botId:b.id,desiredOnline:b.desiredOnline})}catch(e){fail(res,e)}});
app.get('/health',(_q,r)=>r.send('ok'));
db.init().then(()=>app.listen(PORT,'0.0.0.0',()=>console.log('Master Panel ativo na porta',PORT))).catch(e=>{console.error(e);process.exit(1)});
