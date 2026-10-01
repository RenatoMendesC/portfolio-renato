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

document.querySelectorAll('.nav-item,.mobile-nav-item').forEach(btn=>btn.addEventListener('click',()=>{
  const name=btn.dataset.section;
  document.querySelectorAll('.nav-item,.mobile-nav-item').forEach(b=>b.classList.toggle('active',b.dataset.section===name));
  document.querySelectorAll('.page').forEach(p=>p.classList.toggle('active',p.id==='page-'+name));
  const titles={generator:'Gerar clipadas',history:'Histórico',plans:'Planos',settings:'Configurações'};
  pageTitle.textContent=titles[name]||'Norya IA';
  if(name==='history')renderHistory();
  if(name==='settings')checkBridge();
  if(innerWidth<=560)window.scrollTo({top:0,behavior:'smooth'});
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
          const mobile=matchMedia('(max-width: 700px)').matches||/Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
          bridgeCallout.style.display='flex';
          if(mobile){
            bridgeCallout.innerHTML='<div><span class="eyebrow">YOUTUBE BLOQUEOU A NUVEM</span><h4>Continue pelo celular</h4><p>O app está funcionando no mobile. Para este vídeo específico, selecione o arquivo original no celular e a Norya continua a análise automaticamente.</p></div><button class="secondary" id="mobileUploadFallback" type="button">ENVIAR VÍDEO</button>';
            setTimeout(()=>{const b=document.getElementById('mobileUploadFallback');if(b)b.onclick=()=>uploadInput.click()},0);
            showMessage('O YouTube bloqueou a importação cloud deste link. No celular, envie o arquivo original para continuar.','error');
          }else{
            showMessage('O YouTube bloqueou o servidor cloud. Ative o Norya Link Engine e depois continue só colando links.','error');
            checkBridge();
          }
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
  const mobile=matchMedia('(max-width: 700px)').matches||/Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  if(mobile){
    bridgeOnline=false;
    updateBridgeUI(false);
    if(bridgeMiniText)bridgeMiniText.textContent='desktop opcional';
    if(bridgeStatus?.querySelector('span'))bridgeStatus.querySelector('span').textContent='Link Engine disponível no Windows';
    return;
  }
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

// Motion system — soft cloud follows the pointer, with no ring or dot
const root=document.documentElement,glow=$('cursorGlow');
let targetX=innerWidth/2,targetY=innerHeight/2,glowX=targetX,glowY=targetY;
addEventListener('mousemove',e=>{
  targetX=e.clientX;targetY=e.clientY;
  root.style.setProperty('--mx',targetX+'px');root.style.setProperty('--my',targetY+'px');
  root.style.setProperty('--mxn',targetX/innerWidth);root.style.setProperty('--myn',targetY/innerHeight);
});
(function animateGlow(){
  if(glow&&matchMedia('(pointer:fine)').matches){
    glowX+=(targetX-glowX)*.065;glowY+=(targetY-glowY)*.065;
    glow.style.transform=`translate3d(${glowX-280}px,${glowY-190}px,0)`;
  }
  requestAnimationFrame(animateGlow);
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

resetStatus();restoreSession();