const revealEls = document.querySelectorAll('.reveal');
const io = new IntersectionObserver((entries)=>{
  entries.forEach((entry)=>{
    if(entry.isIntersecting){
      entry.target.classList.add('visible');
      io.unobserve(entry.target);
    }
  });
},{threshold:.12});
revealEls.forEach(el=>io.observe(el));

const menuBtn = document.getElementById('menuBtn');
const nav = document.querySelector('.nav');
menuBtn?.addEventListener('click',()=>nav.classList.toggle('open'));
document.querySelectorAll('.nav a').forEach(a=>a.addEventListener('click',()=>nav.classList.remove('open')));

const glow = document.querySelector('.cursor-glow');
window.addEventListener('pointermove',(e)=>{
  glow.style.left = e.clientX+'px';
  glow.style.top = e.clientY+'px';
});

const phrases = [
  'git push origin carreira',
  'npm run construir',
  'node resolver-problema.js',
  'echo "pronto para evoluir"'
];
let p=0,c=0,erase=false;
const typing = document.getElementById('typing');
function typeLoop(){
  const text = phrases[p];
  if(!erase){
    c++;
    typing.textContent=text.slice(0,c);
    if(c===text.length){ erase=true; return setTimeout(typeLoop,1100); }
  } else {
    c--;
    typing.textContent=text.slice(0,c);
    if(c===0){ erase=false;p=(p+1)%phrases.length; }
  }
  setTimeout(typeLoop, erase?35:60);
}
typeLoop();
