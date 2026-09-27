async function call(bot,path,method='GET',body){
 if(!bot.agentUrl)throw new Error('Agent URL não configurada.');
 const c=new AbortController();const t=setTimeout(()=>c.abort(),15000);
 try{const r=await fetch(bot.agentUrl+path,{method,headers:{'content-type':'application/json','authorization':'Bearer '+bot.agentSecret},body:body===undefined?undefined:JSON.stringify(body),signal:c.signal});const text=await r.text();let data;try{data=JSON.parse(text)}catch{data={ok:r.ok,message:text}}if(!r.ok)throw new Error(data.error||data.message||`Agent HTTP ${r.status}`);return data;}finally{clearTimeout(t)}
}
module.exports={call};
