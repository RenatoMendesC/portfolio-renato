const API='https://norya-ia-api-beta.onrender.com';
const BRIDGE='http://127.0.0.1:4788';
let authToken=localStorage.getItem('norya_token')||'';
let currentUser=null;
let bridgeOnline=false;
let activeJob=null;
let pollTimer=null;

const $=id=>document.getElementById(id);
const loginView=$('loginView'),appView=$('appView'),loginForm=$('loginForm'),loginEmail=$('loginEmail'),loginPassword=$('loginPassword'),loginError=$('loginError'),loginButton=$('loginButton');
const videoUrl=$('videoUrl'),rightsConfirm=$('rightsConfirm'),clipCount=$('clipCount'),clipDuration=$('clipDuration'),quality=$('quality'),layout=$('layout');
const generateBtn=$('generateBtn'),uploadBtn=$('uploadBtn'),uploadInput=$('uploadInput'),pasteBtn=$('pasteBtn'),generatorMessage=$('generatorMessage');
const bridgeCallout=$('bridgeCallout'),bridgeMini=$('bridgeMini'),bridgeMiniText=$('bridgeMiniText'),bridgeStatus=$('bridgeStatus');
const sourcePill=$('sourcePill'),statusTitle=$('statusTitle'),statusText=$('statusText'),statusSource=$('statusSource'),activityDot=$('activityDot'),progressRing=$('progressRing'),progressValue=$('progressValue');
const resultsSection=$('resultsSection'),clipsGrid=$('clipsGrid'),resultCount=$('resultCount'),historyList=$('historyList'),pageTitle=$('pageTitle');

function showMessage(text,type=''){
  generatorMessage.textContent=text;
  generatorMessage.className='inline-message '+type;
  generatorMessage.style.display=text?'block':'none';
}
function detectPlatform(raw){
  try{
    const h=new URL(raw).hostname.toLowerCase();
    if(h==='youtu.be'||h==='youtube.com'||h.endsWith('.youtube.com')) return 'YouTube';
    if(h==='tiktok.com'||h.endsWith('.tiktok.com')) return 'TikTok';
    if(h==='instagram.com'||h.endsWith('.instagram.com')) return 'Instagram';
    if(h.includes('drive.google.com')) return 'Drive';
    if(h.includes('dropbox.com')) return 'Dropbox';
    return 'Link direto';
  }catch{return 'Link'}
}
function setProgress(value,title,text){
  const p=Math.max(0,Math.min(100,Math.round(value||0)));
  progressRing.style.setProperty('--p',p);
  progressValue.textContent=p+'%';
  if(title)statusTitle.textContent=title;
  if(text)statusText.textContent=text;
  activityDot.className='activity-dot '+(p>0&&p<100?'busy':p===100?'done':'');
}
function resetStatus(){
  setProgress(0,'Pronto para começar','Cole um link ou envie um vídeo.');
  statusSource.textContent='—';
  activityDot.className='activity-dot';
}
function authHeaders(extra={}){return {...extra,Authorization:'Bearer '+authToken}}

async function restoreSession(){
  if(!authToken)return false;
  try{
    const r=await fetch(API+'/api/auth/me',{headers:authHeaders()});
    const d=await r.json();
    if(!r.ok)throw new Error();
    enterApp(d.user);return true;
  }catch{
    localStorage.removeItem('norya_token');authToken='';return false;
  }
}
function enterApp(user){
  currentUser=user;
  loginView.style.display='none';
  appView.style.display='block';
  $('profileName').textContent=user?.name||'Renato';
  $('profilePlan').textContent=(user?.plan||'MASTER')+' / '+(user?.role||'OWNER');
  checkBridge();
  renderHistory();
}
loginForm.addEventListener('submit',async e=>{
  e.preventDefault();
  loginError.style.display='none';
  loginButton.disabled=true;loginButton.innerHTML='ENTRANDO...';
  try{
    const r=await fetch(API+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:loginEmail.value.trim(),password:loginPassword.value})});
    const d=await r.json().catch(()=>({}));
    if(!r.ok)throw new Error(d.error||'Não foi possível entrar.');
    authToken=d.token;localStorage.setItem('norya_token',authToken);enterApp(d.user);
  }catch(e){
    loginError.textContent=e.message;loginError.style.display='block';
  }finally{
    loginButton.disabled=false;loginButton.innerHTML='ENTRAR <span>→</span>';
  }
});
$('logoutBtn').onclick=()=>{localStorage.removeItem('norya_token');location.reload()};

document.querySelectorAll('.nav-item').forEach(btn=>btn.addEventListener('click',()=>{
  document.querySelectorAll('.nav-item').forEach(b=>b.classList.toggle('active',b===btn));
  const name=btn.dataset.section;
  document.querySelectorAll('.page').forEach(p=>p.classList.toggle('active',p.id==='page-'+name));
  const titles={generator:'Gerar clipadas',history:'Histórico',plans:'Planos',settings:'Configurações'};
  pageTitle.textContent=titles[name]||'Norya IA';
  if(name==='history')renderHistory();
  if(name==='settings')checkBridge();
}));
document.querySelectorAll('[data-nav]').forEach(a=>a.addEventListener('click',e=>{e.preventDefault();document.querySelector('[data-section="generator"]').click()}));

pasteBtn.onclick=async()=>{
  try{
    const text=await navigator.clipboard.readText();
    if(text){videoUrl.value=text;updateSourcePill()}
  }catch{showMessage('O navegador não liberou a área de transferência. Cole o link manualmente.','error')}
};
videoUrl.addEventListener('input',updateSourcePill);
function updateSourcePill(){
  const p=detectPlatform(videoUrl.value.trim());
  sourcePill.textContent=p.toUpperCase();
}

uploadBtn.onclick=()=>uploadInput.click();
uploadInput.onchange=()=>{const f=uploadInput.files?.[0];if(f)startUpload(f)};

function optionsPayload(){
  return {clipCount:Number(clipCount.value),clipDuration:Number(clipDuration.value),quality:quality.value,layout:layout.value};
}
async function startUpload(file){
  clearInterval(pollTimer);showMessage('');
  resultsSection.style.display='none';clipsGrid.innerHTML='';
  statusSource.textContent='UPLOAD';
  setProgress(5,'Enviando vídeo',file.name);
  generateBtn.disabled=true;uploadBtn.disabled=true;
  try{
    const fd=new FormData();fd.append('video',file);
    Object.entries(optionsPayload()).forEach(([k,v])=>fd.append(k,String(v)));
    const r=await fetch(API+'/api/uploads',{method:'POST',headers:authHeaders(),body:fd});
    const d=await r.json().catch(()=>({}));
    if(!r.ok)throw new Error(d.error||'Falha no upload.');
    activeJob=d.job;pollJob(activeJob.id);
  }catch(e){
    setProgress(0,'Falha no upload',e.message);showMessage(e.message,'error');
    generateBtn.disabled=false;uploadBtn.disabled=false;
  }finally{uploadInput.value=''}
}

generateBtn.onclick=async()=>{
  const url=videoUrl.value.trim();
  if(!url)return showMessage('Cole um link para gerar as clipadas.','error');
  const platform=detectPlatform(url);
  if(platform==='YouTube'&&!rightsConfirm.checked)return showMessage('Marque a confirmação de autorização para processar esse conteúdo.','error');
  clearInterval(pollTimer);showMessage('');bridgeCallout.style.display='none';
  resultsSection.style.display='none';clipsGrid.innerHTML='';
  statusSource.textContent=platform;
  generateBtn.disabled=true;uploadBtn.disabled=true;

  if(platform==='YouTube'&&bridgeOnline){
    try{
      setProgress(6,'Norya Link Engine','Importando o YouTube pela sua conexão...');
      const r=await fetch(BRIDGE+'/import',{
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({url,token:authToken,apiUrl:API,options:optionsPayload()})
      });
      const d=await r.json().catch(()=>({}));
      if(!r.ok)throw new Error(d.error||'Falha no Norya Link Engine.');
      activeJob=d.job;pollJob(activeJob.id);return;
    }catch(e){
      bridgeOnline=false;updateBridgeUI(false);
      showMessage('O Link Engine não respondeu. Vou tentar a importação em nuvem.','error');
    }
  }
  startCloudJob(url,platform);
};

async function startCloudJob(url,platform){
  try{
    setProgress(7,platform==='YouTube'?'Importando YouTube':'Importando vídeo','Preparando a fonte...');
    const r=await fetch(API+'/api/jobs',{
      method:'POST',headers:authHeaders({'Content-Type':'application/json'}),
      body:JSON.stringify({url,rightsConfirmed:rightsConfirm.checked,...optionsPayload()})
    });
    const d=await r.json().catch(()=>({}));
    if(!r.ok)throw new Error(d.error||'Não foi possível iniciar o processamento.');
    activeJob=d.job;pollJob(activeJob.id);
  }catch(e){
    setProgress(0,'Não foi possível iniciar',e.message);showMessage(e.message,'error');
    generateBtn.disabled=false;uploadBtn.disabled=false;
  }
}

async function pollJob(id){
  clearInterval(pollTimer);
  const tick=async()=>{
    try{
      const r=await fetch(API+'/api/jobs/'+encodeURIComponent(id),{headers:authHeaders()});
      const d=await r.json().catch(()=>({}));
      if(!r.ok)throw new Error(d.error||'Não consegui consultar o processamento.');
      const j=d.job;activeJob=j;
      setProgress(j.progress,j.status==='done'?'Clipadas prontas':j.status==='error'?'Falha no processamento':j.stage,j.stage);
      if(j.status==='done'){
        clearInterval(pollTimer);renderResults(j);saveHistory(j);
        generateBtn.disabled=false;uploadBtn.disabled=false;showMessage('Processamento concluído.','success');
      }else if(j.status==='error'){
        clearInterval(pollTimer);generateBtn.disabled=false;uploadBtn.disabled=false;
        if(j.errorCode==='YOUTUBE_BLOCKED'){
          bridgeCallout.style.display='flex';
          showMessage('O YouTube bloqueou o servidor cloud. Instale o Norya Link Engine uma vez e depois continue só colando links.','error');
          checkBridge();
        }else showMessage(j.error||'Falha no processamento.','error');
      }
    }catch(e){
      clearInterval(pollTimer);generateBtn.disabled=false;uploadBtn.disabled=false;showMessage(e.message,'error');
    }
  };
  await tick();pollTimer=setInterval(tick,1600);
}
function renderResults(job){
  const base=API;
  resultsSection.style.display='block';
  resultCount.textContent=(job.results?.length||0)+' arquivos';
  clipsGrid.innerHTML='';
  (job.results||[]).forEach((r,i)=>{
    const card=document.createElement('article');card.className='clip-card tilt';
    card.innerHTML=`<div class="clip-preview"><video src="${base+r.url}" controls playsinline preload="metadata"></video><span class="score-badge">NORYA ${r.score}/100</span></div>
      <div class="clip-info"><h4>${r.title||'Clipada #'+(i+1)}</h4><div class="clip-meta"><span>início ${formatTime(r.start)}</span><span>${Math.round(r.duration)}s</span></div>
      <div class="clip-actions"><a class="primary magnetic" href="${base+r.url}" download="norya-clip-${i+1}.mp4">BAIXAR ↓</a></div></div>`;
    clipsGrid.appendChild(card);
  });
  bindTilt();bindMagnetic();
  resultsSection.scrollIntoView({behavior:'smooth',block:'start'});
}
function formatTime(sec){
  sec=Math.max(0,Math.round(sec||0));const m=Math.floor(sec/60),s=sec%60;return String(m).padStart(2,'0')+':'+String(s).padStart(2,'0');
}
function saveHistory(job){
  const data=getHistory();
  data.unshift({id:job.id,source:job.source,createdAt:job.createdAt,results:(job.results||[]).map(r=>({score:r.score,start:r.start,duration:r.duration}))});
  localStorage.setItem('norya_history',JSON.stringify(data.slice(0,30)));
  renderHistory();
}
function getHistory(){try{return JSON.parse(localStorage.getItem('norya_history')||'[]')}catch{return []}}
function renderHistory(){
  const rows=getHistory();
  if(!rows.length){historyList.innerHTML='<div class="empty-state">Nenhuma geração salva ainda.</div>';return}
  historyList.innerHTML=rows.map(h=>{
    const top=Math.max(...(h.results||[]).map(x=>x.score),0);
    return `<article class="history-item tilt"><div><h4>${escapeHtml(h.source||'Vídeo')}</h4><p>${new Date(h.createdAt).toLocaleString('pt-BR')} • ${h.results?.length||0} clipadas</p></div><span class="history-score">${top||'—'}</span></article>`;
  }).join('');
  bindTilt();
}
function escapeHtml(s){return String(s).replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[m]))}

async function checkBridge(){
  const ctrl=new AbortController();const t=setTimeout(()=>ctrl.abort(),900);
  try{
    const r=await fetch(BRIDGE+'/health',{signal:ctrl.signal,cache:'no-store'});
    const d=await r.json();bridgeOnline=!!d.ok;
  }catch{bridgeOnline=false}
  clearTimeout(t);updateBridgeUI(bridgeOnline);
}
function updateBridgeUI(ok){
  bridgeMini.classList.toggle('online',ok);
  bridgeMiniText.textContent=ok?'conectado':'não instalado';
  bridgeStatus.classList.toggle('online',ok);
  bridgeStatus.querySelector('span').textContent=ok?'Conectado e pronto':'Não detectado neste computador';
  if(ok&&bridgeCallout.style.display==='flex')bridgeCallout.style.display='none';
}
setInterval(checkBridge,15000);

// Motion system
const root=document.documentElement,glow=$('cursorGlow'),ring=$('cursorRing'),dot=$('cursorDot');
let targetX=innerWidth/2,targetY=innerHeight/2,ringX=targetX,ringY=targetY,glowX=targetX,glowY=targetY,lastTrail=0;
addEventListener('mousemove',e=>{
  targetX=e.clientX;targetY=e.clientY;
  root.style.setProperty('--mx',targetX+'px');root.style.setProperty('--my',targetY+'px');
  root.style.setProperty('--mxn',targetX/innerWidth);root.style.setProperty('--myn',targetY/innerHeight);
  dot.style.transform=`translate3d(${targetX-2.5}px,${targetY-2.5}px,0)`;
  const hover=!!e.target.closest('button,a,input,select,.tilt');ring.classList.toggle('hover',hover);
  if(performance.now()-lastTrail>42&&matchMedia('(pointer:fine)').matches){
    lastTrail=performance.now();const p=document.createElement('i');p.className='trail';p.style.left=targetX+'px';p.style.top=targetY+'px';document.body.appendChild(p);setTimeout(()=>p.remove(),600);
  }
});
(function animateCursor(){
  ringX+=(targetX-ringX)*.2;ringY+=(targetY-ringY)*.2;glowX+=(targetX-glowX)*.075;glowY+=(targetY-glowY)*.075;
  ring.style.transform=`translate3d(${ringX-ring.offsetWidth/2}px,${ringY-ring.offsetHeight/2}px,0)`;
  glow.style.transform=`translate3d(${glowX-170}px,${glowY-170}px,0)`;
  requestAnimationFrame(animateCursor);
})();

function bindTilt(){
  if(!matchMedia('(pointer:fine)').matches)return;
  document.querySelectorAll('.tilt').forEach(card=>{
    if(card.dataset.tiltBound)return;card.dataset.tiltBound='1';
    card.addEventListener('mousemove',e=>{
      const r=card.getBoundingClientRect(),x=e.clientX-r.left,y=e.clientY-r.top;
      card.style.setProperty('--card-x',x+'px');card.style.setProperty('--card-y',y+'px');
      const rx=((y/r.height)-.5)*-4,ry=((x/r.width)-.5)*5;
      card.style.transform=`perspective(900px) rotateX(${rx}deg) rotateY(${ry}deg) translateZ(0)`;
    });
    card.addEventListener('mouseleave',()=>card.style.transform='');
  });
}
function bindMagnetic(){
  if(!matchMedia('(pointer:fine)').matches)return;
  document.querySelectorAll('.magnetic').forEach(el=>{
    if(el.dataset.magBound)return;el.dataset.magBound='1';
    el.addEventListener('mousemove',e=>{
      const r=el.getBoundingClientRect(),x=e.clientX-(r.left+r.width/2),y=e.clientY-(r.top+r.height/2);
      el.style.transform=`translate(${x*.08}px,${y*.1}px)`;
    });
    el.addEventListener('mouseleave',()=>el.style.transform='');
  });
}
bindTilt();bindMagnetic();

const canvas=$('motionCanvas'),ctx=canvas.getContext('2d');let particles=[];
function resizeCanvas(){canvas.width=innerWidth*devicePixelRatio;canvas.height=innerHeight*devicePixelRatio;canvas.style.width=innerWidth+'px';canvas.style.height=innerHeight+'px';ctx.setTransform(devicePixelRatio,0,0,devicePixelRatio,0,0)}
function seed(){particles=Array.from({length:Math.min(55,Math.floor(innerWidth/22))},()=>({x:Math.random()*innerWidth,y:Math.random()*innerHeight,vx:(Math.random()-.5)*.16,vy:(Math.random()-.5)*.16,r:Math.random()*1.2+.3}))}
function draw(){
  ctx.clearRect(0,0,innerWidth,innerHeight);
  for(const p of particles){
    p.x+=p.vx;p.y+=p.vy;if(p.x<0)p.x=innerWidth;if(p.x>innerWidth)p.x=0;if(p.y<0)p.y=innerHeight;if(p.y>innerHeight)p.y=0;
    const dx=p.x-targetX,dy=p.y-targetY,dist=Math.hypot(dx,dy);if(dist<160){p.x+=dx/(dist||1)*.18;p.y+=dy/(dist||1)*.18}
    ctx.beginPath();ctx.arc(p.x,p.y,p.r,0,Math.PI*2);ctx.fillStyle='rgba(184,255,61,.25)';ctx.fill();
  }
  requestAnimationFrame(draw);
}
addEventListener('resize',()=>{resizeCanvas();seed()});resizeCanvas();seed();draw();

resetStatus();restoreSession();