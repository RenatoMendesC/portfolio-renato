const express=require('express');
const cors=require('cors');
const helmet=require('helmet');
const rateLimit=require('express-rate-limit');
const multer=require('multer');
const ffmpeg=require('ffmpeg-static');
const ffprobe=require('ffprobe-static').path;
const youtubedl=require('youtube-dl-exec');
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
const WORK=path.join(os.tmpdir(),'norya-production');
const INPUTS=path.join(WORK,'inputs');
const CLIPS=path.join(WORK,'clips');
const MAX_BYTES=300*1024*1024;
const MAX_JOB_AGE=1000*60*60*2;
const jobs=new Map();

const MASTER_EMAIL=(process.env.MASTER_EMAIL||'').trim().toLowerCase();
const MASTER_PASSWORD_HASH=(process.env.MASTER_PASSWORD_HASH||'').trim().toLowerCase();
const MASTER_PASSWORD_SALT=(process.env.MASTER_PASSWORD_SALT||'').trim().toLowerCase();
const MASTER_PASSWORD=process.env.MASTER_PASSWORD||'';
const SESSION_SECRET=process.env.SESSION_SECRET||'';
const APIFY_TOKEN=(process.env.APIFY_TOKEN||'').trim();
const NORYA_SELF_TEST_URL=(process.env.NORYA_SELF_TEST_URL||'').trim();

for(const dir of [WORK,INPUTS,CLIPS]){try{fss.mkdirSync(dir,{recursive:true})}catch{}}

app.set('trust proxy',1);
app.use(helmet({crossOriginResourcePolicy:{policy:'cross-origin'}}));
app.use(cors({origin:true,credentials:false}));
app.use(express.json({limit:'64kb'}));
app.use(rateLimit({windowMs:60_000,limit:90,standardHeaders:true,legacyHeaders:false}));
app.use('/clips',express.static(CLIPS,{maxAge:'20m',fallthrough:false}));

function b64url(input){return Buffer.from(input).toString('base64url')}
function signSession(payload){
  if(!SESSION_SECRET) throw new Error('SESSION_SECRET ausente.');
  const body=b64url(JSON.stringify(payload));
  const sig=crypto.createHmac('sha256',SESSION_SECRET).update(body).digest('base64url');
  return body+'.'+sig;
}
function verifySession(token){
  if(!token||!SESSION_SECRET) return null;
  const [body,sig]=String(token).split('.');
  if(!body||!sig) return null;
  const expected=crypto.createHmac('sha256',SESSION_SECRET).update(body).digest();
  let got;
  try{got=Buffer.from(sig,'base64url')}catch{return null}
  if(expected.length!==got.length||!crypto.timingSafeEqual(expected,got)) return null;
  try{
    const data=JSON.parse(Buffer.from(body,'base64url').toString('utf8'));
    if(!data.exp||Date.now()>data.exp) return null;
    return data;
  }catch{return null}
}
function secureEqual(a,b){
  const x=crypto.createHash('sha256').update(String(a)).digest();
  const y=crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x,y);
}
function passwordMatches(raw){
  if(MASTER_PASSWORD_HASH&&MASTER_PASSWORD_SALT){
    try{
      const actual=crypto.scryptSync(String(raw),Buffer.from(MASTER_PASSWORD_SALT,'hex'),64,{N:16384,r:8,p:1}).toString('hex');
      return secureEqual(actual,MASTER_PASSWORD_HASH);
    }catch{}
  }
  return !!MASTER_PASSWORD && secureEqual(String(raw),MASTER_PASSWORD);
}
function requireAuth(req,res,next){
  const raw=req.headers.authorization||'';
  const token=raw.startsWith('Bearer ')?raw.slice(7):'';
  const user=verifySession(token);
  if(!user) return res.status(401).json({error:'Sessão inválida ou expirada.'});
  req.user=user;next();
}

const upload=multer({
  storage:multer.diskStorage({
    destination:(req,file,cb)=>cb(null,INPUTS),
    filename:(req,file,cb)=>cb(null,crypto.randomUUID()+path.extname(file.originalname||'.mp4'))
  }),
  limits:{fileSize:MAX_BYTES},
  fileFilter:(req,file,cb)=>{
    const ok=(file.mimetype||'').startsWith('video/')||file.mimetype==='application/octet-stream';
    cb(ok?null:new Error('Envie um arquivo de vídeo válido.'),ok);
  }
});

function detectPlatform(raw){
  let u;try{u=new URL(raw)}catch{return null}
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
  let u;try{u=new URL(raw)}catch{return raw}
  const host=u.hostname.toLowerCase();
  if(host==='drive.google.com'){
    const m=u.pathname.match(/\/file\/d\/([^/]+)/);
    const id=m?.[1]||u.searchParams.get('id');
    if(id) return 'https://drive.usercontent.google.com/download?id='+encodeURIComponent(id)+'&export=download&confirm=t';
  }
  if(host==='dropbox.com'||host==='www.dropbox.com'){
    u.searchParams.set('dl','1');u.searchParams.delete('raw');return u.toString();
  }
  return raw;
}
async function validateRemoteUrl(raw){
  let u;try{u=new URL(raw)}catch{throw new Error('Link inválido.')}
  if(!['http:','https:'].includes(u.protocol)) throw new Error('Use um link http ou https.');
  if(detectPlatform(raw)) return u;
  const entries=await dns.lookup(u.hostname,{all:true});
  if(!entries.length||entries.some(x=>privateIP(x.address))) throw new Error('Esse endereço não pode ser acessado.');
  return u;
}
async function safeFetch(raw,maxRedirects=4){
  let current=normalizeExternalSource(raw);
  for(let i=0;i<=maxRedirects;i++){
    await validateRemoteUrl(current);
    const res=await fetch(current,{redirect:'manual',headers:{'User-Agent':'NoryaIA/1.0'}});
    if([301,302,303,307,308].includes(res.status)){
      const loc=res.headers.get('location');if(!loc) throw new Error('Redirecionamento inválido.');
      current=new URL(loc,current).toString();continue;
    }
    if(!res.ok) throw new Error('Não consegui acessar a mídia (HTTP '+res.status+').');
    return res;
  }
  throw new Error('Muitos redirecionamentos.');
}
async function downloadDirect(url,dest){
  const res=await safeFetch(url);
  const len=Number(res.headers.get('content-length')||0);
  const type=(res.headers.get('content-type')||'').toLowerCase();
  if(len&&len>MAX_BYTES) throw new Error('O vídeo ultrapassa 300 MB.');
  if(type&&!type.startsWith('video/')&&!type.includes('octet-stream')) throw new Error('O link não aponta para um arquivo de vídeo acessível.');
  let bytes=0;
  const limiter=new Transform({transform(chunk,enc,cb){bytes+=chunk.length;if(bytes>MAX_BYTES)return cb(new Error('O vídeo ultrapassa 300 MB.'));cb(null,chunk)}});
  await pipeline(Readable.fromWeb(res.body),limiter,fss.createWriteStream(dest));
}
async function apifyJson(url,options={}){
  const resp=await fetch(url,options);
  const textBody=await resp.text();
  let data={};
  try{data=textBody?JSON.parse(textBody):{}}catch{data={raw:textBody.slice(0,500)}}
  if(!resp.ok){
    const detail=data?.error?.message||data?.message||('HTTP '+resp.status);
    throw new Error('Apify: '+detail);
  }
  return data;
}

async function runApifyActor(actor,input,timeoutMs=420000){
  const token=encodeURIComponent(APIFY_TOKEN);
  console.log('[NORYA_IMPORT] Starting actor',actor);

  const started=await apifyJson(
    'https://api.apify.com/v2/acts/'+actor+'/runs?token='+token+'&memory=1024',
    {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify(input)
    }
  );

  const run=started?.data||started;
  const runId=run?.id;
  if(!runId) throw new Error('Apify não retornou o ID da execução.');

  const deadline=Date.now()+timeoutMs;
  let finalRun=run;

  while(Date.now()<deadline){
    const status=String(finalRun?.status||'').toUpperCase();
    if(['SUCCEEDED','FAILED','ABORTED','TIMED-OUT'].includes(status)) break;
    await new Promise(r=>setTimeout(r,2500));
    const state=await apifyJson('https://api.apify.com/v2/actor-runs/'+encodeURIComponent(runId)+'?token='+token);
    finalRun=state?.data||state;
    console.log('[NORYA_IMPORT]',actor,'status:',finalRun?.status||'UNKNOWN');
  }

  const status=String(finalRun?.status||'').toUpperCase();
  if(status!=='SUCCEEDED') throw new Error(actor+' terminou com status '+(status||'DESCONHECIDO')+'.');

  const datasetId=finalRun?.defaultDatasetId||run?.defaultDatasetId;
  if(!datasetId) throw new Error(actor+' não retornou dataset.');

  const items=await apifyJson(
    'https://api.apify.com/v2/datasets/'+encodeURIComponent(datasetId)+'/items?token='+token+'&clean=true'
  );
  return Array.isArray(items)?items:[];
}

function withApifyToken(raw){
  try{
    const u=new URL(raw);
    if(u.hostname==='api.apify.com'&&!u.searchParams.has('token')) u.searchParams.set('token',APIFY_TOKEN);
    return u.toString();
  }catch{return raw}
}

async function importWithLurkApi(url,quality){
  const items=await runApifyActor('lurkapi~youtube-video-downloader',{
    videoUrls:[url],
    quality,
    format:'mp4',
    includeSubtitles:false,
    maxConcurrency:1,
    proxyConfiguration:{
      useApifyProxy:true,
      apifyProxyGroups:['RESIDENTIAL']
    }
  });

  const item=items.find(x=>x&&(x.videoFileUrl||String(x.status||'').toLowerCase()==='success'))||items[0];
  if(!item) throw new Error('LurkAPI não retornou resultado.');
  if(item.error) throw new Error('LurkAPI: '+item.error);
  const downloadUrl=item.videoFileUrl||item.downloadUrl;
  if(!downloadUrl) throw new Error('LurkAPI não retornou URL do vídeo.');
  return {downloadUrl,fileSize:Number(item.fileSize||0),fileSizeMB:Number(item.fileSizeMB||0),provider:'lurkapi'};
}

async function importWithBoztek(url,quality){
  const items=await runApifyActor('boztek-ltd~youtube-downloader',{
    startUrls:[{url}],
    downloadType:'video',
    quality
  });

  const item=items.find(x=>x&&(x.downloadUrl||String(x.status||'').toUpperCase()==='SUCCESS'))||items[0];
  if(!item) throw new Error('Boztek não retornou resultado.');
  if(item.error) throw new Error('Boztek: '+item.error);
  const downloadUrl=item.downloadUrl;
  if(!downloadUrl) throw new Error('Boztek não retornou URL do vídeo.');
  return {downloadUrl,fileSize:Number(item.fileSize||0),fileSizeMB:Number(item.fileSizeMB||0),provider:'boztek'};
}

async function downloadYoutubeProvider(url,dest){
  if(!APIFY_TOKEN) throw new Error('Provider de importação não configurado.');

  const qualities=['720p','480p','360p'];
  let lastError=null;

  for(const quality of qualities){
    for(const provider of [importWithLurkApi,importWithBoztek]){
      try{
        console.log('[NORYA_IMPORT] Trying',provider.name,quality);
        const item=await provider(url,quality);
        const size=item.fileSize||0;
        const sizeMb=item.fileSizeMB||0;
        if((size&&size>MAX_BYTES)||(sizeMb&&sizeMb>MAX_BYTES/1024/1024)){
          console.warn('[NORYA_IMPORT] Too large from',item.provider,quality,sizeMb||Math.round(size/1024/1024),'MB');
          lastError=new Error('Arquivo muito grande em '+quality+'.');
          continue;
        }

        console.log('[NORYA_IMPORT] Download URL from',item.provider,quality);
        await downloadDirect(withApifyToken(item.downloadUrl),dest);
        console.log('[NORYA_IMPORT] Video imported successfully via',item.provider,quality);
        return true;
      }catch(e){
        lastError=e;
        console.error('[NORYA_IMPORT]',provider.name,'failed at',quality+':',e.message);
        await fs.rm(dest,{force:true}).catch(()=>{});
        await new Promise(r=>setTimeout(r,900));
      }
    }
  }

  throw lastError||new Error('Importação indisponível.');
}

async function downloadYoutube(url,dest){
  let providerError=null;
  if(APIFY_TOKEN){
    try{
      await downloadYoutubeProvider(url,dest);
      return;
    }catch(e){
      providerError=e;
      await fs.rm(dest,{force:true}).catch(()=>{});
    }
  }

  try{
    await youtubedl(url,{
      noPlaylist:true,noWarnings:true,
      format:'best[ext=mp4][height<=720]/best[height<=720]/best',
      output:dest,forceOverwrites:true,maxFilesize:'300M',
      socketTimeout:30,retries:2
    },{timeout:240000});
    const st=await fs.stat(dest);
    if(!st.size) throw new Error('Arquivo vazio.');
    if(st.size>MAX_BYTES){await fs.rm(dest,{force:true});throw new Error('O vídeo ultrapassa 300 MB.')}
  }catch(e){
    await fs.rm(dest,{force:true}).catch(()=>{});
    const msg=String(e?.stderr||e?.message||e);
    if(providerError) console.error('[NORYA_IMPORT] Provider failed:',providerError.message);
    console.error('[NORYA_IMPORT] Direct importer failed:',msg.slice(0,700));
    const err=new Error(/private|members.only|unavailable/i.test(msg)
      ? 'Este vídeo não está disponível para processamento.'
      : 'Não foi possível importar este vídeo automaticamente.');
    err.code=/private|members.only|unavailable/i.test(msg)?'SOURCE_UNAVAILABLE':'IMPORT_UNAVAILABLE';
    if(providerError) err.providerFallbackTried=true;
    throw err;
  }
}
function execCapture(bin,args,timeout=120000){
  return new Promise((resolve,reject)=>{
    const p=spawn(bin,args,{windowsHide:true});let out='',err='';
    const t=setTimeout(()=>{p.kill('SIGKILL');reject(new Error('Tempo limite excedido.'))},timeout);
    p.stdout.on('data',d=>out+=d.toString());
    p.stderr.on('data',d=>err+=d.toString());
    p.on('error',e=>{clearTimeout(t);reject(e)});
    p.on('close',code=>{clearTimeout(t);code===0?resolve(out.trim()):reject(new Error(err||'Falha no processo.'))});
  });
}
async function probeDuration(input){
  const v=await execCapture(ffprobe,['-v','error','-show_entries','format=duration','-of','default=nw=1:nk=1',input]);
  const n=Number(v);if(!Number.isFinite(n)||n<=0) throw new Error('Não consegui ler a duração do vídeo.');
  return n;
}
async function energyTimeline(input){
  return new Promise((resolve,reject)=>{
    const p=spawn(ffmpeg,['-hide_banner','-loglevel','error','-i',input,'-vn','-ac','1','-ar','1000','-f','s16le','pipe:1'],{windowsHide:true});
    const energies=[];let sum=0,count=0;const sampleRate=1000;
    p.stdout.on('data',buf=>{
      const len=buf.length-(buf.length%2);
      for(let i=0;i<len;i+=2){
        const s=buf.readInt16LE(i)/32768;sum+=s*s;count++;
        if(count>=sampleRate){energies.push(Math.sqrt(sum/count));sum=0;count=0;}
      }
    });
    let err='';p.stderr.on('data',d=>err+=d.toString());
    p.on('error',reject);
    p.on('close',code=>{
      if(count>0) energies.push(Math.sqrt(sum/count));
      code===0?resolve(energies):reject(new Error(err||'Falha ao analisar áudio.'));
    });
  });
}
function mean(a){return a.length?a.reduce((x,y)=>x+y,0)/a.length:0}
function std(a,m){if(!a.length)return 0;return Math.sqrt(a.reduce((s,x)=>s+(x-m)*(x-m),0)/a.length)}
function selectMoments(energies,duration,clipDuration,count){
  if(duration<=clipDuration+2) return [{start:0,score:88}];
  const step=5,window=Math.min(clipDuration,Math.floor(duration)-1),candidates=[];
  for(let start=0;start+window<=Math.floor(duration);start+=step){
    const seg=energies.slice(start,start+window);if(!seg.length) continue;
    const m=mean(seg),sd=std(seg,m);
    const sorted=[...seg].sort((a,b)=>b-a);
    const peakMean=mean(sorted.slice(0,Math.max(1,Math.floor(sorted.length*.2))));
    const active=seg.filter(x=>x>0.012).length/seg.length;
    let score=m*1.6+sd*.85+peakMean*.65+active*.025;
    if(start<5) score*=.9;
    candidates.push({start,raw:score});
  }
  candidates.sort((a,b)=>b.raw-a.raw);
  const picked=[];
  for(const c of candidates){
    if(picked.every(p=>Math.abs(p.start-c.start)>=Math.max(clipDuration*.7,22))){
      picked.push(c);if(picked.length>=count) break;
    }
  }
  if(!picked.length) picked.push({start:Math.max(0,Math.floor(duration/2-clipDuration/2)),raw:.02});
  const vals=picked.map(x=>x.raw),lo=Math.min(...vals),hi=Math.max(...vals);
  return picked.map((x,i)=>({start:x.start,score:Math.round(hi===lo?88-i*3:82+((x.raw-lo)/(hi-lo))*15)}));
}
function renderClip(input,output,start,duration,quality,layout){
  const w=quality==='1080'?1080:720,h=quality==='1080'?1920:1280;
  const vf=layout==='blur'
    ? `split[bg][fg];[bg]scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},boxblur=26:2[bg2];[fg]scale=${w}:${h}:force_original_aspect_ratio=decrease[fg2];[bg2][fg2]overlay=(W-w)/2:(H-h)/2`
    : `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h}`;
  return new Promise((resolve,reject)=>{
    const args=['-y','-hide_banner','-loglevel','error','-ss',String(start),'-i',input,'-t',String(duration),'-vf',vf,'-c:v','libx264','-preset','veryfast','-crf',quality==='1080'?'25':'26','-c:a','aac','-b:a','128k','-movflags','+faststart',output];
    const p=spawn(ffmpeg,args,{windowsHide:true});let err='';
    p.stderr.on('data',d=>err+=d.toString());p.on('error',reject);
    p.on('close',code=>code===0?resolve():reject(new Error(err||'Falha ao renderizar clipada.')));
  });
}
function publicJob(job){
  return {
    id:job.id,status:job.status,progress:job.progress,stage:job.stage,error:job.error||null,errorCode:job.errorCode||null,
    source:job.source,createdAt:job.createdAt,results:job.results||[]
  };
}
function updateJob(id,patch){const j=jobs.get(id);if(j)Object.assign(j,patch)}
async function processJob(job){
  let input=job.inputPath||path.join(INPUTS,job.id+'.source');
  try{
    updateJob(job.id,{status:'processing',progress:8,stage:'Importando vídeo'});
    if(!job.inputPath){
      const platform=detectPlatform(job.source);
      if(platform==='YouTube') await downloadYoutube(job.source,input);
      else if(platform==='TikTok'||platform==='Instagram'){
        const e=new Error('TikTok e Instagram ainda precisam de link direto do arquivo nesta versão.');e.code='PLATFORM_NEEDS_DIRECT';throw e;
      }else await downloadDirect(job.source,input);
    }
    updateJob(job.id,{progress:30,stage:'Analisando conteúdo'});
    const duration=await probeDuration(input);
    const energies=await energyTimeline(input);
    const moments=selectMoments(energies,duration,job.options.clipDuration,job.options.clipCount);
    updateJob(job.id,{progress:56,stage:'Selecionando melhores momentos'});
    const results=[];
    for(let i=0;i<moments.length;i++){
      const m=moments[i];
      const file=job.id+'-'+(i+1)+'.mp4',output=path.join(CLIPS,file);
      updateJob(job.id,{progress:56+Math.round(((i+1)/moments.length)*38),stage:'Renderizando clipada '+(i+1)+' de '+moments.length});
      await renderClip(input,output,m.start,Math.min(job.options.clipDuration,Math.max(8,duration-m.start)),job.options.quality,job.options.layout);
      results.push({
        id:i+1,
        score:m.score,
        start:m.start,
        duration:Math.min(job.options.clipDuration,Math.max(8,duration-m.start)),
        url:'/clips/'+file,
        title:'Clipada #'+(i+1)
      });
    }
    updateJob(job.id,{status:'done',progress:100,stage:'Clipadas prontas',results});
  }catch(e){
    updateJob(job.id,{status:'error',progress:100,stage:'Falha no processamento',error:e.message||'Falha no processamento.',errorCode:e.code||'PROCESSING_ERROR'});
  }finally{
    if(input) await fs.rm(input,{force:true}).catch(()=>{});
  }
}

app.get('/health',(req,res)=>res.json({ok:true,version:'1.0.1',engine:'Norya Momentum Engine',authConfigured:!!(MASTER_EMAIL&&(MASTER_PASSWORD||(MASTER_PASSWORD_HASH&&MASTER_PASSWORD_SALT))&&SESSION_SECRET),linkImportProvider:APIFY_TOKEN?'configured':'direct'}));
app.post('/api/auth/login',(req,res)=>{
  const email=String(req.body?.email||'').trim().toLowerCase(),password=String(req.body?.password||'');
  if(!MASTER_EMAIL||(!MASTER_PASSWORD&&!(MASTER_PASSWORD_HASH&&MASTER_PASSWORD_SALT))||!SESSION_SECRET) return res.status(503).json({error:'Acesso MASTER não configurado.'});
  if(!secureEqual(email,MASTER_EMAIL)||!passwordMatches(password)) return res.status(401).json({error:'E-mail ou senha inválidos.'});
  const user={name:'Renato',role:'OWNER',plan:'MASTER',unlimited:true};
  const token=signSession({...user,iat:Date.now(),exp:Date.now()+1000*60*60*24*7});
  res.json({ok:true,token,user});
});
app.get('/api/auth/me',requireAuth,(req,res)=>res.json({ok:true,user:{name:req.user.name,role:req.user.role,plan:req.user.plan,unlimited:!!req.user.unlimited}}));

app.post('/api/jobs',requireAuth,(req,res)=>{
  const source=String(req.body?.url||'').trim();
  if(!source) return res.status(400).json({error:'Cole um link para começar.'});
  const platform=detectPlatform(source);
  if(platform==='YouTube'&&req.body?.rightsConfirmed!==true) return res.status(400).json({error:'Confirme que você possui o conteúdo ou tem autorização para processá-lo.'});
  const clipCount=Math.max(1,Math.min(5,Number(req.body?.clipCount)||3));
  const clipDuration=Math.max(20,Math.min(60,Number(req.body?.clipDuration)||40));
  const quality=req.body?.quality==='1080'?'1080':'720';
  const layout=req.body?.layout==='blur'?'blur':'crop';
  const id=crypto.randomUUID();
  const job={id,status:'queued',progress:2,stage:'Na fila',source,createdAt:new Date().toISOString(),options:{clipCount,clipDuration,quality,layout},results:[]};
  jobs.set(id,job);setImmediate(()=>processJob(job));
  res.status(202).json({ok:true,job:publicJob(job)});
});
app.post('/api/uploads',requireAuth,upload.single('video'),(req,res)=>{
  if(!req.file) return res.status(400).json({error:'Selecione um vídeo.'});
  const clipCount=Math.max(1,Math.min(5,Number(req.body?.clipCount)||3));
  const clipDuration=Math.max(20,Math.min(60,Number(req.body?.clipDuration)||40));
  const quality=req.body?.quality==='1080'?'1080':'720';
  const layout=req.body?.layout==='blur'?'blur':'crop';
  const id=crypto.randomUUID();
  const job={id,status:'queued',progress:2,stage:'Na fila',source:req.file.originalname||'upload',inputPath:req.file.path,createdAt:new Date().toISOString(),options:{clipCount,clipDuration,quality,layout},results:[]};
  jobs.set(id,job);setImmediate(()=>processJob(job));
  res.status(202).json({ok:true,job:publicJob(job)});
});
app.get('/api/jobs/:id',requireAuth,(req,res)=>{
  const job=jobs.get(req.params.id);if(!job)return res.status(404).json({error:'Job não encontrado.'});
  res.json({ok:true,job:publicJob(job)});
});

app.use((err,req,res,next)=>{
  if(err?.code==='LIMIT_FILE_SIZE') return res.status(413).json({error:'O vídeo ultrapassa 300 MB.'});
  if(err) return res.status(400).json({error:err.message||'Falha na requisição.'});
  next();
});

setInterval(()=>{
  const now=Date.now();
  for(const [id,j] of jobs){
    if(now-new Date(j.createdAt).getTime()>MAX_JOB_AGE){
      for(const r of j.results||[]) fs.rm(path.join(CLIPS,path.basename(r.url)),{force:true}).catch(()=>{});
      jobs.delete(id);
    }
  }
},10*60*1000).unref();

app.listen(PORT,'0.0.0.0',()=>{
  console.log('Norya IA 1.0 API on '+PORT+' | Apify '+(APIFY_TOKEN?'ON':'OFF'));
  if(NORYA_SELF_TEST_URL){
    setTimeout(async()=>{
      const dest=path.join(INPUTS,'selftest-'+Date.now()+'.mp4');
      try{
        console.log('[NORYA_SELFTEST] START',NORYA_SELF_TEST_URL);
        await downloadYoutubeProvider(NORYA_SELF_TEST_URL,dest);
        const st=await fs.stat(dest);
        console.log('[NORYA_SELFTEST] SUCCESS bytes='+st.size);
      }catch(e){
        console.error('[NORYA_SELFTEST] FAILED',e.message);
      }finally{
        await fs.rm(dest,{force:true}).catch(()=>{});
      }
    },2500);
  }
});