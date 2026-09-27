const crypto = require('crypto');
function key(){
  const raw=String(process.env.DATA_ENCRYPTION_KEY||'');
  if(!raw) throw new Error('DATA_ENCRYPTION_KEY não configurada.');
  return crypto.createHash('sha256').update(raw).digest();
}
function encrypt(value){
  if(value===undefined||value===null||value==='') return '';
  const iv=crypto.randomBytes(12); const cipher=crypto.createCipheriv('aes-256-gcm',key(),iv);
  const enc=Buffer.concat([cipher.update(String(value),'utf8'),cipher.final()]);
  const tag=cipher.getAuthTag(); return ['v1',iv.toString('base64'),tag.toString('base64'),enc.toString('base64')].join(':');
}
function decrypt(value){
  if(!value) return '';
  const p=String(value).split(':'); if(p.length!==4||p[0]!=='v1') throw new Error('Segredo criptografado inválido.');
  const decipher=crypto.createDecipheriv('aes-256-gcm',key(),Buffer.from(p[1],'base64'));
  decipher.setAuthTag(Buffer.from(p[2],'base64'));
  return Buffer.concat([decipher.update(Buffer.from(p[3],'base64')),decipher.final()]).toString('utf8');
}
module.exports={encrypt,decrypt};
