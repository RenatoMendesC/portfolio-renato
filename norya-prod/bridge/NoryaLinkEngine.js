const http=require('http');
const fs=require('fs');
const fsp=require('fs/promises');
const os=require('os');
const path=require('path');
const crypto=require('crypto');
const axios=require('axios');
const FormData=require('form-data');
const youtubedl=require('youtube-dl-exec');

const PORT=4788;
const HOST='127.0.0.1';
const MAX_BYTES=300*1024*1024;

function headers(res){
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type,Authorization,Access-Control-Request-Private-Network');
  res.setHeader('Access-Control-Allow-Private-Network','true');
  res.setHeader('Cache-Control','no-store');
}
function send(res,status,obj){
  headers(res);
  res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});
  res.end(JSON.stringify(obj));
}
function parseBody(req){
  return new Promise((resolve,reject)=>{
    let body='';req.on('data',d=>{body+=d;if(body.length>1024*1024){reject(new Error('Requisição muito grande.'));req.destroy();}});
    req.on('end',()=>{try{resolve(JSON.parse(body||'{}'))}catch{reject(new Error('JSON inválido.'))}});
    req.on('error',reject);
  });
}
function isYoutube(raw){
  try{
    const h=new URL(raw).hostname.toLowerCase();
    return h==='youtu.be'||h==='youtube.com'||h.endsWith('.youtube.com');
  }catch{return false}
}
async function importYoutube({url,token,apiUrl,options}){
  if(!isYoutube(url)) throw new Error('Cole um link válido do YouTube.');
  if(!token) throw new Error('Sessão Norya ausente.');
  if(!apiUrl||!/^https:\/\//i.test(apiUrl)) throw new Error('API Norya inválida.');

  const dir=path.join(os.tmpdir(),'norya-link-engine');
  await fsp.mkdir(dir,{recursive:true});
  const file=path.join(dir,crypto.randomUUID()+'.mp4');

  try{
    await youtubedl(url,{
      noPlaylist:true,
      noWarnings:true,
      format:'best[ext=mp4][height<=720]/best[height<=720]/best',
      output:file,
      forceOverwrites:true,
      maxFilesize:'300M',
      socketTimeout:30,
      retries:2
    },{timeout:240000});

    const st=await fsp.stat(file);
    if(!st.size) throw new Error('O YouTube não retornou um arquivo.');
    if(st.size>MAX_BYTES) throw new Error('O vídeo ultrapassa 300 MB.');

    const form=new FormData();
    form.append('video',fs.createReadStream(file),{filename:'youtube.mp4',contentType:'video/mp4'});
    form.append('clipCount',String(options?.clipCount||3));
    form.append('clipDuration',String(options?.clipDuration||40));
    form.append('quality',String(options?.quality||'720'));
    form.append('layout',String(options?.layout||'crop'));

    const resp=await axios.post(apiUrl.replace(/\/$/,'')+'/api/uploads',form,{
      headers:{...form.getHeaders(),Authorization:'Bearer '+token},
      maxBodyLength:Infinity,
      maxContentLength:Infinity,
      timeout:180000,
      validateStatus:()=>true
    });
    if(resp.status<200||resp.status>=300) throw new Error(resp.data?.error||'A API Norya recusou o upload.');
    return resp.data;
  }finally{
    await fsp.rm(file,{force:true}).catch(()=>{});
  }
}

const server=http.createServer(async(req,res)=>{
  headers(res);
  if(req.method==='OPTIONS'){res.writeHead(204);return res.end();}
  if(req.method==='GET'&&req.url==='/health') return send(res,200,{ok:true,name:'Norya Link Engine',version:'1.0.0'});
  if(req.method==='POST'&&req.url==='/import'){
    try{
      const body=await parseBody(req);
      const result=await importYoutube(body);
      return send(res,200,result);
    }catch(e){
      return send(res,400,{error:e.message||'Falha ao importar o YouTube pelo Link Engine.'});
    }
  }
  send(res,404,{error:'Rota não encontrada.'});
});

server.listen(PORT,HOST,()=>{
  console.log('');
  console.log('==========================================');
  console.log(' NORYA LINK ENGINE 1.0');
  console.log(' Status: ONLINE');
  console.log(' Porta: http://127.0.0.1:'+PORT);
  console.log(' Pode deixar esta janela aberta.');
  console.log('==========================================');
  console.log('');
});