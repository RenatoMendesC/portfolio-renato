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
const MASTER_EMAIL=(process.env.MASTER_EMAIL||'').trim().toLowerCase();
const MASTER_PASSWORD=process.env.MASTER_PASSWORD||'';
const SESSION_SECRET=process.env.SESSION_SECRET||'';

function b64url(input){
  return Buffer.from(input).toString('base64url');
}
function signSession(payload){
  if(!SESSION_SECRET) throw new Error('SESSION_SECRET não configurado.');
  const body=b64url(JSON.stringify(payload));
  const sig=crypto.createHmac('sha256',SESSION_SECRET).update(body).digest('base64url');
  return body+'.'+sig;
}
function verifySession(token){
  if(!token||!SESSION_SECRET) return null;
  const [body,sig]=String(token).split('.');
  if(!body||!sig) return null;
  const expected=crypto.createHmac('sha256',SESSION_SECRET).update(body).digest();
  let provided;
  try{provided=Buffer.from(sig,'base64url')}catch{return null}
  if(expected.length!==provided.length||!crypto.timingSafeEqual(expected,provided)) return null;
  try{
    const payload=JSON.parse(Buffer.from(body,'base64url').toString('utf8'));
    if(!payload.exp||Date.now()>payload.exp) return null;
    return payload;
  }catch{return null}
}
function safeCredentialEqual(a,b){
  const ah=crypto.createHash('sha256').update(String(a)).digest();
  const bh=crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ah,bh);
}
function requireAuth(req,res,next){
  const raw=req.headers.authorization||'';
  const token=raw.startsWith('Bearer ')?raw.slice(7):'';
  const user=verifySession(token);
  if(!user) return res.status(401).json({error:'Sessão inválida ou expirada.'});
  req.user=user;
  next();
}
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

function detectPlatform(raw){
  let u;
  try{u=new URL(raw)}catch{return null}
  const h=u.hostname.toLowerCase();
  if(h==='youtu.be'||h==='youtube.com'||h.endsWith('.youtube.com')) return 'YouTube';
  if(h==='tiktok.com'||h.endsWith('.tiktok.com')) return 'TikTok';
  if(h==='instagram.com'||h.endsWith('.instagram.com')) return 'Instagram';
  return null;
}

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
function normalizeExternalSource(raw){
  let u;
  try{u=new URL(raw)}catch{return raw}
  const host=u.hostname.toLowerCase();

  if(host==='drive.google.com'){
    const byPath=u.pathname.match(/\/file\/d\/([^/]+)/);
    const byQuery=u.searchParams.get('id');
    const id=byPath?.[1]||byQuery;
    if(id) return 'https://drive.usercontent.google.com/download?id='+encodeURIComponent(id)+'&export=download&confirm=t';
  }

  if(host==='www.dropbox.com'||host==='dropbox.com'){
    u.searchParams.set('dl','1');
    u.searchParams.delete('raw');
    return u.toString();
  }

  return raw;
}

async function validateUrl(raw){
  let u;
  try{u=new URL(raw)}catch{throw new Error('Link inválido.')}
  if(!['http:','https:'].includes(u.protocol)) throw new Error('Use apenas links http ou https.');
  const host=u.hostname.toLowerCase();
  if(blockedHosts.some(h=>host===h||host.endsWith('.'+h))){
    const e=new Error('Este endereço é de uma plataforma social. Vincule uma fonte original autorizada para processar o vídeo.');
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
  url=normalizeExternalSource(url);
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
app.get('/health',(req,res)=>res.json({ok:true,service:'norya-ia-beta-api',ffmpeg:!!ffmpeg,authConfigured:!!(MASTER_EMAIL&&MASTER_PASSWORD&&SESSION_SECRET)}));

app.post('/api/auth/login',(req,res)=>{
  const email=String(req.body?.email||'').trim().toLowerCase();
  const password=String(req.body?.password||'');
  if(!MASTER_EMAIL||!MASTER_PASSWORD||!SESSION_SECRET) return res.status(503).json({error:'Login MASTER ainda não configurado.'});
  if(!safeCredentialEqual(email,MASTER_EMAIL)||!safeCredentialEqual(password,MASTER_PASSWORD)){
    return res.status(401).json({error:'E-mail ou senha inválidos.'});
  }
  const user={name:'MASTER',role:'OWNER',plan:'MASTER',unlimited:true};
  const token=signSession({...user,iat:Date.now(),exp:Date.now()+1000*60*60*24*7});
  res.json({ok:true,token,user});
});

app.get('/api/auth/me',requireAuth,(req,res)=>{
  res.json({ok:true,user:{name:req.user.name,role:req.user.role,plan:req.user.plan,unlimited:!!req.user.unlimited}});
});
app.post('/api/clip',requireAuth,async(req,res)=>{
  if(busy) return res.status(429).json({error:'A beta está processando outro vídeo. Tente novamente em instantes.'});
  const platformUrl=String(req.body?.platformUrl||'').trim();
  const legacyUrl=String(req.body?.url||'').trim();
  const sourceUrl=String(req.body?.sourceUrl||legacyUrl||'').trim();
  if(!sourceUrl) return res.status(400).json({error:'Informe a fonte original do vídeo.'});

  const detected=detectPlatform(sourceUrl);
  if(detected && !req.body?.sourceUrl){
    return res.status(409).json({
      needsSource:true,
      platform:detected,
      platformUrl:legacyUrl||sourceUrl,
      message:'Fonte original necessária'
    });
  }

  busy=true;
  await fs.mkdir(CLIPS,{recursive:true});
  const id=crypto.randomUUID();
  const input=path.join(WORK,id+'-input');
  const output=path.join(CLIPS,id+'.mp4');
  try{
    await downloadVideo(sourceUrl,input);
    await runFfmpeg(input,output);
    await fs.rm(input,{force:true});
    const proto=req.get('x-forwarded-proto')||req.protocol;
    const downloadUrl=proto+'://'+req.get('host')+'/clips/'+id+'.mp4';
    setTimeout(()=>fs.rm(output,{force:true}).catch(()=>{}),20*60*1000).unref();
    res.json({
      ok:true,
      downloadUrl,
      durationSeconds:30,
      format:'720x1280',
      score:92,
      platformUrl:platformUrl||null,
      note:platformUrl
        ? 'Fonte original vinculada ao vídeo do YouTube. Beta: nesta etapa a Norya usa os primeiros 30 segundos para validar a renderização.'
        : 'Beta: recorte dos primeiros 30 segundos. A seleção inteligente de momento entra na próxima etapa.'
    });
  }catch(e){
    await fs.rm(input,{force:true}).catch(()=>{});
    await fs.rm(output,{force:true}).catch(()=>{});
    res.status(e.code==='UNSUPPORTED_PLATFORM'?422:400).json({error:e.message||'Não foi possível gerar o clipe.'});
  }finally{busy=false;}
});

app.post('/api/upload',requireAuth,upload.single('video'),async(req,res)=>{
  const platformUrl=String(req.body?.platformUrl||'').trim();
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
    res.json({
      ok:true,
      downloadUrl,
      durationSeconds:30,
      format:'720x1280',
      score:92,
      platformUrl:platformUrl||null,
      note:platformUrl
        ? 'Arquivo original vinculado ao vídeo do YouTube e processado em 9:16. Beta: nesta etapa a Norya usa os primeiros 30 segundos para validar o motor.'
        : 'Beta: arquivo processado em 9:16. Nesta etapa, a Norya usa os primeiros 30 segundos para validar o motor de renderização.'
    });
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