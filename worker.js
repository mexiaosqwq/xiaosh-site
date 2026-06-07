const HOME = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>xiaosh.xyz</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
      min-height: 100vh;
      display: flex; align-items: center; justify-content: center;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: #fff;
    }
    h1 { font-size: clamp(2rem, 8vw, 4rem); text-align: center; }
    p { text-align: center; margin-top: 1rem; opacity: 0.85; font-size: 1.1rem; }
    .links { margin-top: 2rem; text-align: center; }
    .links a { color: #fff; text-decoration: none; padding: 8px 20px; border: 2px solid rgba(255,255,255,0.5); border-radius: 20px; transition: all .2s; }
    .links a:hover { background: rgba(255,255,255,0.15); border-color: #fff; }
  </style>
</head>
<body>
  <div>
    <h1>xiaosh.xyz</h1>
    <p>网站搭建中...</p>
    <div class="links">
      <a href="https://2048.xiaosh.xyz">玩 2048</a>
    </div>
  </div>
</body>
</html>`;

const GAME_2048 = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no"><title>2048 - xiaosh.xyz</title><style>
*{margin:0;padding:0;box-sizing:border-box}body{font-family:"Clear Sans","Helvetica Neue",Arial,sans-serif;background:#faf8ef;display:flex;justify-content:center;align-items:flex-start;min-height:100vh;padding-top:40px}.container{width:100%;max-width:500px;padding:0 15px}.back-link{display:inline-block;margin-bottom:15px;color:#776e65;text-decoration:none;font-size:14px}.back-link:hover{text-decoration:underline}.header{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:20px;gap:10px}.title{font-size:clamp(40px,10vw,80px);font-weight:bold;color:#776e65;line-height:1}.scores-container{display:flex;gap:8px}.score-box{background:#bbada0;padding:8px 20px;border-radius:6px;text-align:center;min-width:60px;position:relative}.score-label{font-size:11px;color:#eee4da;text-transform:uppercase;font-weight:bold}.score-value{font-size:clamp(20px,4vw,28px);font-weight:bold;color:#fff;line-height:1;margin-top:4px}.score-add{position:absolute;right:0;bottom:0;font-size:clamp(18px,4vw,26px);font-weight:bold;color:#776e65;line-height:1;pointer-events:none;animation:s .6s ease-out forwards}@keyframes s{0%{opacity:1;transform:translateY(0)}100%{opacity:0;transform:translateY(-30px)}}.sub-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:20px;gap:10px}.subtitle{font-size:clamp(14px,3vw,18px);color:#776e65;line-height:1.4;flex:1}.subtitle strong{color:#776e65}.new-game-btn{background:#8f7a66;color:#f9f6f2;border:none;padding:10px 25px;font-size:clamp(14px,3vw,18px);font-weight:bold;border-radius:6px;cursor:pointer;transition:background .2s;white-space:nowrap;touch-action:manipulation;user-select:none}.new-game-btn:hover{background:#9f8a76}.game-board{background:#bbada0;border-radius:10px;padding:15px;position:relative;width:100%;touch-action:none}.grid-container{display:grid;grid-template-columns:repeat(4,1fr);grid-template-rows:repeat(4,1fr);gap:15px;width:100%;aspect-ratio:1}.grid-cell{background:rgba(238,228,218,.35);border-radius:6px;width:100%;height:100%}.tile{border-radius:6px;display:flex;justify-content:center;align-items:center;font-weight:bold;position:absolute;transition:all .18s cubic-bezier(.25,.46,.45,.94);z-index:10}.tile.new{animation:a .28s ease-out}.tile.merged{animation:p .28s cubic-bezier(.34,1.56,.64,1)}@keyframes a{0%{transform:scale(0);opacity:0}50%{transform:scale(.8);opacity:.8}100%{transform:scale(1);opacity:1}}@keyframes p{0%{transform:scale(1)}50%{transform:scale(1.1)}70%{transform:scale(.98)}100%{transform:scale(1)}}.tile-2{background:#eee4da}.tile-4{background:#ede0c8}.tile-2,.tile-4{color:#776e65;font-size:clamp(25px,8vw,55px)}.tile-8{background:#f2b179}.tile-16{background:#f59563}.tile-32{background:#f67c5f}.tile-64{background:#f65e3b}.tile-8,.tile-16,.tile-32,.tile-64{color:#f9f6f2;font-size:clamp(25px,8vw,55px)}.tile-128{background:#edcf72}.tile-256{background:#edcc61}.tile-512{background:#edc850}.tile-128,.tile-256,.tile-512{color:#f9f6f2;font-size:clamp(22px,7vw,50px)}.tile-1024{background:#edc53f}.tile-2048{background:#edc22e}.tile-1024,.tile-2048{color:#f9f6f2;font-size:clamp(18px,6vw,42px)}.tile-super{background:#3c3a32;color:#f9f6f2;font-size:clamp(16px,5vw,36px)}#tileContainer{position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:10}.game-over{position:absolute;top:0;left:0;right:0;bottom:0;background:rgba(238,228,218,.73);display:flex;flex-direction:column;justify-content:center;align-items:center;border-radius:10px;z-index:100;opacity:0;pointer-events:none;transition:opacity .3s ease}.game-over.active{opacity:1;pointer-events:auto}.game-over h2{font-size:clamp(30px,8vw,60px);font-weight:bold;color:#776e65;margin-bottom:20px;text-align:center}.game-over p{font-size:clamp(14px,3vw,18px);color:#776e65;text-align:center;padding:0 20px}@media(max-width:400px){.game-board{padding:10px}.grid-container{gap:10px}.header,.sub-header{margin-bottom:15px}}
</style></head><body>
<div class="container"><a class="back-link" href="https://xiaosh.xyz">← xiaosh.xyz</a><div class="header"><div class="title">2048</div><div class="scores-container"><div class="score-box"><div class="score-label">分数</div><div class="score-value" id="score">0</div></div><div class="score-box"><div class="score-label">最高分</div><div class="score-value" id="bestScore">0</div></div></div></div><div class="sub-header"><div class="subtitle">合并数字到达 <strong>2048</strong> 方块！</div><button class="new-game-btn" onclick="newGame()">新游戏</button></div><div class="game-board"><div class="grid-container" id="gridContainer"></div><div id="tileContainer"></div><div class="game-over" id="gameOver"><h2>游戏结束!</h2><p>按"新游戏"按钮重新开始</p></div></div></div>
<script>
let g,s,b=localStorage.getItem('bestScore2048-xiaosh')||0,t=0,a=0,sc=document.getElementById('score'),be=document.getElementById('bestScore'),go=document.getElementById('gameOver'),gc=document.getElementById('gridContainer'),tc=document.getElementById('tileContainer')
newGame=_=>{g=Array(4).fill().map(()=>Array(4).fill(0)),s=t=0,u(),go.classList.remove('active'),A(),A(),r()}
A=_=>{let e=[],r,c;for(r=0;r<4;r++)for(c=0;c<4;c++)if(!g[r][c])e.push({r,c});if(e.length){({r,c}=e[Math.random()*e.length|0]),g[r][c]={v:Math.random()<.9?2:4,id:t++,n:1}}}
r=_=>{let c=tc,q=document.querySelectorAll('.grid-cell'),e={};c.querySelectorAll('.tile').forEach(t=>e[t.dataset.id]=t);let b=c.getBoundingClientRect();for(let i=0;i<4;i++)for(let j=0;j<4;j++){let l=g[i][j];if(!l)continue;let el=q[i*4+j],rect=el.getBoundingClientRect(),x=rect.left-b.left,y=rect.top-b.top,w=rect.width+'px',h=rect.height+'px';if(l.q&&l.f){l.f.forEach(id=>{let t=e[id];t&&(delete e[id],t.style.cssText='width:'+w+';height:'+h+';left:'+x+'px;top:'+y+'px;transition-delay:0ms',setTimeout(()=>{t.style.cssText+=';opacity:0;transform:scale(0)',setTimeout(()=>t.remove(),180)},180))}),setTimeout(()=>{let n=document.createElement('div');n.className='tile '+(l.v<2049?'tile-'+l.v:'tile-super')+' merged',n.textContent=l.v,n.dataset.id=l.id;let rect=el.getBoundingClientRect();n.style.cssText='width:'+rect.width+'px;height:'+rect.height+'px;left:'+(rect.left-b.left)+'px;top:'+(rect.top-b.top)+'px',c.appendChild(n),g[i][j]&&(g[i][j].q=0)},180);continue}let t=e[l.id];t?(delete e[l.id],t.textContent!=l.v&&(t.className='tile '+(l.v<2049?'tile-'+l.v:'tile-super'),t.textContent=l.v)):(t=document.createElement('div'),t.className='tile '+(l.v<2049?'tile-'+l.v:'tile-super')+(l.n?' new':''),t.textContent=l.v,t.dataset.id=l.id,l.n&&(l.n=0),c.appendChild(t)),t.style.cssText='width:'+w+';height:'+h+';left:'+x+'px;top:'+y+'px;transition-delay:0ms',l.m&&(t.classList.add('merged'),l.m=0)}Object.values(e).forEach(t=>{t.style.cssText+=';opacity:0;transform:scale(0)',setTimeout(()=>t.remove(),180)})}
u=_=>{sc.textContent=s,s>b&&(localStorage.setItem('bestScore2048-xiaosh',b=s)),be.textContent=b}
p=r=>{let f=r.filter(Boolean),x=[],i=0;for(;i<f.length;i++)i<f.length-1&&f[i].v==f[i+1].v?(s+=f[i].v*2,x.push({v:f[i].v*2,id:t++,m:1,f:[f[i].id,f[i+1].id],q:1}),i++):x.push(f[i]);for(;x.length<4;)x.push(0);return x}
m=d=>{if(a)return;let k=0,o=s,l=g=>{let n=p(g);return k=k||n.some((v,i)=>v!==g[i]),n};({left:_=>{for(let r=0;r<4;r++)g[r]=l(g[r])},right:_=>{for(let r=0;r<4;r++)g[r]=l([...g[r]].reverse()).reverse()},up:_=>{for(let c=0;c<4;c++){let x=[0,1,2,3].map(r=>g[r][c]);l(x).forEach((v,r)=>g[r][c]=v)}},down:_=>{for(let c=0;c<4;c++){let x=[0,1,2,3].map(r=>g[r][c]);l([...x].reverse()).reverse().forEach((v,r)=>g[r][c]=v)}}}[d])();k&&(A(),u(),s-o&&((x=document.createElement('div'),x.className='score-add',x.textContent='+'+(s-o),document.querySelector('.score-box').appendChild(x),setTimeout(()=>x.remove(),600))),r(),a=1,setTimeout(()=>a=0,200),i()&&setTimeout(()=>go.classList.add('active'),1000))}
i=_=>{for(let r=0;r<4;r++)for(let c=0;c<4;c++)if(!g[r][c]||c<3&&g[r][c].v==g[r][c+1].v||r<3&&g[r][c].v==g[r+1][c].v)return 0;return 1}
document.addEventListener('keydown',e=>{let k={ArrowUp:'up',ArrowDown:'down',ArrowLeft:'left',ArrowRight:'right'};k[e.key]&&(e.preventDefault(),m(k[e.key]))})
let x,y;document.addEventListener('touchstart',e=>{x=e.touches[0].clientX,y=e.touches[0].clientY},{passive:0}),document.addEventListener('touchmove',e=>e.preventDefault(),{passive:0}),document.addEventListener('touchend',e=>{if(!x)return;let d=e.changedTouches[0].clientX-x,t=e.changedTouches[0].clientY-y;Math.max(Math.abs(d),Math.abs(t))>50&&m(Math.abs(d)>Math.abs(t)?d>0?'right':'left':t>0?'down':'up'),x=y=0})
gc.innerHTML='<div class="grid-cell"></div>'.repeat(16),be.textContent=b;let z;window.addEventListener('resize',()=>{clearTimeout(z),z=setTimeout(r,100)}),newGame()
</script>
</body></html>`;

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const host = url.hostname;

    let html;
    if (host === '2048.xiaosh.xyz' || host.startsWith('2048.')) {
      html = GAME_2048;
    } else {
      html = HOME;
    }

    return new Response(html, {
      headers: { "content-type": "text/html;charset=UTF-8" },
    });
  },
};
