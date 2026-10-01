const express=require('express');
const cors=require('cors');
const ffmpeg=require('ffmpeg-static');
const multer=require('multer');
const {spawn}=require('child_process');
const {promises:fs}=require('fs');
const fss=require('fs');
const path=require('path');
const os=require('os');
const dns=require('dns').promises;
const crypto=require('crypto');
const {Readable,Transform}=require('stream');
const {pipeline}=require('stream/promises');

const app=express();
const PORT=process.env.PORT||10000;
const WORK=path.join(os.tmpdir(),'norya-beta');
const CLIPS=path.join(WORK,'clips');
const UPLOADS=path.join(WORK,'uploads');
const MAX_BYTES=200*1024*1024;
let busy=false;
const upload=multer({
  storage:multer.diskStorage({
    destination:(req,file,cb)=>{try{fss.mkdirSync(UPLOADS,{recursive:true});cb(null,UPLOADS)}catch(e){cb(e)}},
    filename:(req,file,cb)=>cb(null,crypto.randomUUID()+path.extname(file.originalname||''))
  }),
  limits:{fileSize:MAX_BYTES},
  fileFilter:(req,file,cb)=>{
    const ok=(file.mimetype||'').startsWith('video/')||['application/octet-stream'].includes(file.mimetype||'');
    cb(ok?null:new Error('Envie um arquivo de vídeo válido.'),ok);
  }
});

app.set('trust proxy',1);
app.use(cors({origin:'*'}));
app.use(express.json({limit:'32kb'}));
app.use('/clips',express.static(CLIPS,{maxAge:0,fallthrough:false}));

const blockedHosts=['youtube.com','www.youtube.com','m.youtube.com','youtu.be','tiktok.com','www.tiktok.com','instagram.com','www.instagram.com'];

function privateIPv4(ip){
  const p=ip.split('.').map(Number);
  if(p.length!==4||p.some(Number.isNaN)) return false;
  return p[0]===10||p[0]===127||p[0]===0||(p[0]===169&&p[1]===254)||(p[0]===172&&p[1]>=16&&p[1]<=31)||(p[0]===192&&p[1]===168)||(p[0]===100&&p[1]>=64&&p[1]<=127)||p[0]>=224;
}
function privateIP(ip){
  if(ip.includes(':')){
    const s=ip.toLowerCase();
    return s==='::1'||s==='::'||s.startsWith('fc')||s.startsWith('fd')||s.startsWith('fe8')||s.startsWith('fe9')||s.startsWith('fea')||s.startsWith('feb');
  }
  return privateIPv4(ip);
}
async function validateUrl(raw){
  let u;
  try{u=new URL(raw)}catch{throw new Error('Link inválido.')}
  if(!['http:','https:'].includes(u.protocol)) throw new Error('Use apenas links http ou https.');
  const host=u.hostname.toLowerCase();
  if(blockedHosts.some(h=>host===h||host.endsWith('.'+h))){
    const e=new Error('Nesta beta, links do YouTube/TikTok/Instagram ainda não são processados diretamente. Use um link direto de vídeo (.mp4) ou o vídeo-demo.');
    e.code='UNSUPPORTED_PLATFORM';
    throw e;
  }
  const entries=await dns.lookup(host,{all:true});
  if(!entries.length||entries.some(x=>privateIP(x.address))) throw new Error('Esse endereço não pode ser acessado.');
  return u;
}
async function safeFetch(raw,maxRedirects=4){
  let current=raw;
  for(let i=0;i<=maxRedirects;i++){
    await validateUrl(current);
    const res=await fetch(current,{redirect:'manual',headers:{'User-Agent':'NoryaIA-Beta/1.0'}});
    if([301,302,303,307,308].includes(res.status)){
      const loc=res.headers.get('location');
      if(!loc) throw new Error('Redirecionamento inválido.');
      current=new URL(loc,current).toString();
      continue;
    }
    if(!res.ok) throw new Error('Não consegui acessar esse vídeo (HTTP '+res.status+').');
    return res;
  }
  throw new Error('Muitos redirecionamentos.');
}
async function downloadVideo(url,dest){
  const res=await safeFetch(url);
  const len=Number(res.headers.get('content-length')||0);
  const type=(res.headers.get('content-type')||'').toLowerCase();
  if(len&&len>MAX_BYTES) throw new Error('O vídeo excede 200 MB nesta beta.');
  if(type&&!type.startsWith('video/')&&!type.includes('octet-stream')) throw new Error('O link não parece apontar para um arquivo de vídeo direto.');
  let bytes=0;
  const limiter=new Transform({transform(chunk,enc,cb){bytes+=chunk.length;if(bytes>MAX_BYTES)return cb(new Error('O vídeo excede 200 MB nesta beta.'));cb(null,chunk);}});
  await pipeline(Readable.fromWeb(res.body),limiter,fss.createWriteStream(dest));
}
function runFfmpeg(input,output){
  return new Promise((resolve,reject)=>{
    const args=['-y','-hide_banner','-loglevel','error','-ss','0','-i',input,'-t','30','-vf','scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280','-c:v','libx264','-preset','veryfast','-crf','26','-c:a','aac','-b:a','128k','-movflags','+faststart',output];
    const p=spawn(ffmpeg,args);
    let err='';
    p.stderr.on('data',d=>err+=d.toString());
    p.on('error',reject);
    p.on('close',code=>code===0?resolve():reject(new Error(err||'Falha no FFmpeg.')));
  });
}
app.get('/health',(req,res)=>res.json({ok:true,service:'norya-ia-beta-api',ffmpeg:!!ffmpeg}));
app.post('/api/clip',async(req,res)=>{
  if(busy) return res.status(429).json({error:'A beta está processando outro vídeo. Tente novamente em instantes.'});
  const url=String(req.body?.url||'').trim();
  if(!url) return res.status(400).json({error:'Cole um link de vídeo.'});
  busy=true;
  await fs.mkdir(CLIPS,{recursive:true});
  const id=crypto.randomUUID();
  const input=path.join(WORK,id+'-input');
  const output=path.join(CLIPS,id+'.mp4');
  try{
    await downloadVideo(url,input);
    await runFfmpeg(input,output);
    await fs.rm(input,{force:true});
    const proto=req.get('x-forwarded-proto')||req.protocol;
    const downloadUrl=proto+'://'+req.get('host')+'/clips/'+id+'.mp4';
    setTimeout(()=>fs.rm(output,{force:true}).catch(()=>{}),20*60*1000).unref();
    res.json({ok:true,downloadUrl,durationSeconds:30,format:'720x1280',score:92,note:'Beta: recorte dos primeiros 30 segundos. A seleção inteligente de momento entra na próxima etapa.'});
  }catch(e){
    await fs.rm(input,{force:true}).catch(()=>{});
    await fs.rm(output,{force:true}).catch(()=>{});
    res.status(e.code==='UNSUPPORTED_PLATFORM'?422:400).json({error:e.message||'Não foi possível gerar o clipe.'});
  }finally{busy=false;}
});

app.post('/api/upload',upload.single('video'),async(req,res)=>{
  if(busy){
    if(req.file?.path) await fs.rm(req.file.path,{force:true}).catch(()=>{});
    return res.status(429).json({error:'A beta está processando outro vídeo. Tente novamente em instantes.'});
  }
  if(!req.file) return res.status(400).json({error:'Selecione um arquivo de vídeo.'});
  busy=true;
  await fs.mkdir(CLIPS,{recursive:true});
  const id=crypto.randomUUID();
  const input=req.file.path;
  const output=path.join(CLIPS,id+'.mp4');
  try{
    await runFfmpeg(input,output);
    await fs.rm(input,{force:true});
    const proto=req.get('x-forwarded-proto')||req.protocol;
    const downloadUrl=proto+'://'+req.get('host')+'/clips/'+id+'.mp4';
    setTimeout(()=>fs.rm(output,{force:true}).catch(()=>{}),20*60*1000).unref();
    res.json({ok:true,downloadUrl,durationSeconds:30,format:'720x1280',score:92,note:'Beta: arquivo processado em 9:16. Nesta etapa, a Norya usa os primeiros 30 segundos para validar o motor de renderização.'});
  }catch(e){
    await fs.rm(input,{force:true}).catch(()=>{});
    await fs.rm(output,{force:true}).catch(()=>{});
    res.status(400).json({error:e.message||'Não foi possível processar o arquivo.'});
  }finally{busy=false;}
});

app.use((err,req,res,next)=>{
  if(err && err.code==='LIMIT_FILE_SIZE') return res.status(413).json({error:'O vídeo excede 200 MB nesta beta.'});
  if(err) return res.status(400).json({error:err.message||'Falha no upload.'});
  next();
});

app.listen(PORT,'0.0.0.0',()=>console.log('Norya IA beta API on '+PORT));