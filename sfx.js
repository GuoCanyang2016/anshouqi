/* 童年游戏 · 共用音效（全部用 WebAudio 现场合成，不需要音频文件）
 *
 * 用法：页面里 <script src="../sfx.js"></script>，然后调用
 *   SFX.play('dirtFlip')            立刻播放
 *   SFX.play('dirtThud', 0.45)      0.45 秒后播放（等走子动画落地）
 * 页面左下角会自动出现一个 🔊/🔇 静音按钮，静音状态所有游戏共用。
 *
 * 音色分组：
 *   dirt*   三个翻牌游戏：小时候在土地上画格子、拿石子/纸牌玩的声音
 *   wood*   象棋：木头棋子落在木棋盘上
 *   beep*   弹球掉梯子：诺基亚蜂鸣器
 *   tile*   2048
 *   win / lose  结束时的小旋律
 */
(function(){
  var AC=window.AudioContext||window.webkitAudioContext;
  var ctx=null,master=null,noiseBuf=null,gritBuf=null;
  var muted=false;
  try{muted=localStorage.getItem('sfx_muted')==='1';}catch(e){}

  function init(){
    if(ctx||!AC)return ctx;
    try{
      ctx=new AC();
      master=ctx.createGain();master.gain.value=0.9;master.connect(ctx.destination);
      // 白噪声
      var n=ctx.sampleRate;
      noiseBuf=ctx.createBuffer(1,n,ctx.sampleRate);
      var d=noiseBuf.getChannelData(0);
      for(var i=0;i<n;i++)d[i]=Math.random()*2-1;
      // 沙土颗粒声：稀疏的小脉冲叠在弱噪声上，像树枝刮过土里的小石子
      gritBuf=ctx.createBuffer(1,n,ctx.sampleRate);
      var g=gritBuf.getChannelData(0);
      for(var j=0;j<n;j++){
        var v=(Math.random()*2-1)*0.25;
        if(Math.random()<0.012)v+=(Math.random()*2-1)*1.6;
        g[j]=Math.max(-1,Math.min(1,v));
      }
    }catch(e){ctx=null;}
    return ctx;
  }
  // iOS/Chrome 要求用户先点一下页面才能出声
  function unlock(){
    if(!init())return;
    if(ctx.state==='suspended'){try{ctx.resume();}catch(e){}}
  }
  ['pointerdown','touchend','keydown','click'].forEach(function(ev){
    window.addEventListener(ev,unlock,{capture:true,passive:true});
  });

  // ---------- 基础积木 ----------
  function env(g,t,a,peak,dec){
    g.gain.setValueAtTime(0.0001,t);
    g.gain.exponentialRampToValueAtTime(peak,t+a);
    g.gain.exponentialRampToValueAtTime(0.0001,t+a+dec);
  }
  // 一段滤波噪声
  function noise(t,o){
    var src=ctx.createBufferSource();
    src.buffer=o.grit?gritBuf:noiseBuf;
    src.playbackRate.value=o.rate||1;
    var f=ctx.createBiquadFilter();
    f.type=o.type||'bandpass';
    f.frequency.setValueAtTime(o.f,t);
    if(o.f2)f.frequency.exponentialRampToValueAtTime(o.f2,t+(o.a||0.005)+o.dec);
    f.Q.value=o.q||1;
    var g=ctx.createGain();
    env(g,t,o.a||0.005,o.v,o.dec);
    src.connect(f);f.connect(g);g.connect(master);
    src.start(t,Math.random()*0.5);src.stop(t+(o.a||0.005)+o.dec+0.05);
  }
  // 一个音
  function tone(t,o){
    var osc=ctx.createOscillator();
    osc.type=o.wave||'sine';
    osc.frequency.setValueAtTime(o.f,t);
    if(o.f2)osc.frequency.exponentialRampToValueAtTime(o.f2,t+(o.a||0.005)+o.dec);
    var g=ctx.createGain();
    env(g,t,o.a||0.005,o.v,o.dec);
    osc.connect(g);g.connect(master);
    osc.start(t);osc.stop(t+(o.a||0.005)+o.dec+0.05);
  }
  // 方波短音（诺基亚蜂鸣器），起止干脆
  function beep(t,f,dur,v){
    var osc=ctx.createOscillator();osc.type='square';osc.frequency.value=f;
    var g=ctx.createGain();
    g.gain.setValueAtTime(0,t);g.gain.linearRampToValueAtTime(v,t+0.004);
    g.gain.setValueAtTime(v,t+dur-0.01);g.gain.linearRampToValueAtTime(0,t+dur);
    osc.connect(g);g.connect(master);osc.start(t);osc.stop(t+dur+0.02);
  }

  // ---------- 音效表 ----------
  var S={
    // ===== 土地（兽棋 / 刀杀鸡 / 军棋）=====
    // 翻牌：手指把纸牌从土上掀起来 "唰"，带点沙粒
    dirtFlip:function(t){
      noise(t,{grit:true,f:2600,f2:1500,q:0.9,v:0.55,a:0.01,dec:0.16});
      noise(t+0.02,{f:5200,type:'highpass',v:0.10,a:0.005,dec:0.07});
    },
    // 走子：在土上拖过去 "沙——"
    dirtSlide:function(t){
      noise(t,{grit:true,f:1400,f2:900,q:0.7,v:0.35,a:0.06,dec:0.32});
    },
    // 落子：拍在土上 "噗"
    dirtPlace:function(t){
      tone(t,{f:150,f2:70,v:0.45,dec:0.09});
      noise(t,{type:'lowpass',f:700,v:0.35,dec:0.08});
    },
    // 吃子：用力拍下去 + 土渣飞溅
    dirtThud:function(t){
      tone(t,{f:120,f2:45,v:0.85,dec:0.16});
      noise(t,{type:'lowpass',f:900,f2:300,v:0.6,dec:0.14});
      noise(t+0.03,{grit:true,f:3000,q:0.8,v:0.28,a:0.005,dec:0.18});
    },
    // 同归于尽 / 炸弹 / 火箭："嘭" 再撒一把土
    dirtBoom:function(t){
      tone(t,{f:90,f2:30,v:1.0,dec:0.35});
      noise(t,{type:'lowpass',f:1200,f2:120,v:0.9,a:0.005,dec:0.45});
      noise(t+0.08,{grit:true,f:2400,f2:1200,q:0.6,v:0.35,a:0.02,dec:0.4});
    },
    // 选中棋子：手指点了一下土
    dirtTap:function(t){
      noise(t,{type:'lowpass',f:1200,v:0.18,dec:0.035});
    },

    // ===== 木头（象棋）=====
    woodPick:function(t){
      noise(t,{f:2600,q:4,v:0.18,dec:0.03});
      tone(t,{f:1300,v:0.07,dec:0.03});
    },
    // 落子 "哒"
    woodPlace:function(t){
      noise(t,{f:1900,q:3.5,v:0.7,a:0.002,dec:0.05});
      tone(t,{f:820,f2:700,v:0.32,a:0.002,dec:0.07});
      tone(t,{f:240,f2:180,v:0.35,a:0.002,dec:0.10});
    },
    // 吃子：重重拍下，两颗棋子相撞 "啪嗒"
    woodCapture:function(t){
      noise(t,{f:1500,q:2.5,v:0.95,a:0.002,dec:0.07});
      tone(t,{f:640,f2:520,v:0.45,a:0.002,dec:0.09});
      tone(t,{f:190,f2:130,v:0.55,a:0.002,dec:0.14});
      noise(t+0.07,{f:2600,q:4,v:0.35,a:0.002,dec:0.04});
      tone(t+0.07,{f:1050,v:0.15,a:0.002,dec:0.05});
    },
    // 将军：两声清脆的提示
    woodCheck:function(t){
      tone(t,{f:988,v:0.22,dec:0.12,wave:'triangle'});
      tone(t+0.13,{f:1319,v:0.22,dec:0.2,wave:'triangle'});
    },

    // ===== 诺基亚蜂鸣器（弹球掉梯子）=====
    beepStart:function(t){beep(t,1047,0.07,0.12);beep(t+0.09,1568,0.1,0.12);},
    beepLand:function(t){beep(t,1760,0.018,0.05);},
    beepHeart:function(t){beep(t,1319,0.06,0.12);beep(t+0.07,1760,0.06,0.12);beep(t+0.14,2637,0.1,0.12);},
    beepDie:function(t){
      var osc=ctx.createOscillator();osc.type='square';
      osc.frequency.setValueAtTime(880,t);osc.frequency.exponentialRampToValueAtTime(110,t+0.45);
      var g=ctx.createGain();g.gain.setValueAtTime(0.12,t);g.gain.linearRampToValueAtTime(0,t+0.48);
      osc.connect(g);g.connect(master);osc.start(t);osc.stop(t+0.5);
    },
    beepLevel:function(t){beep(t,2093,0.05,0.1);beep(t+0.08,2093,0.05,0.1);},
    beepOver:function(t){
      [784,659,523,392].forEach(function(f,i){beep(t+i*0.16,f,0.13,0.12);});
    },

    // ===== 2048 =====
    tileSlide:function(t){noise(t,{type:'bandpass',f:1800,f2:900,q:0.8,v:0.12,a:0.01,dec:0.08});},
    tileMerge:function(t,v){
      var lv=Math.log2(v||4);   // 4→2, 2048→11
      var f=260*Math.pow(1.12,lv);
      tone(t,{f:f,f2:f*1.5,v:0.28,a:0.005,dec:0.12,wave:'triangle'});
      tone(t,{f:f*2,v:0.06,a:0.005,dec:0.08});
    },

    // ===== 结束 =====
    win:function(t){
      [523,659,784,1047].forEach(function(f,i){tone(t+i*0.11,{f:f,v:0.22,dec:0.25,wave:'triangle'});});
    },
    lose:function(t){
      [392,349,311,262].forEach(function(f,i){tone(t+i*0.16,{f:f,v:0.2,dec:0.3,wave:'triangle'});});
    }
  };

  var SFX={
    play:function(name,delay,arg){
      if(muted||!S[name])return;
      if(!init())return;
      if(ctx.state==='suspended'){try{ctx.resume();}catch(e){}}
      try{S[name](ctx.currentTime+0.005+(delay||0),arg);}catch(e){if(SFX.debug)console.error('SFX '+name,e);}
    },
    // 按结局文字自动判断胜负音
    result:function(text){
      text=String(text||'');
      if(/你赢|你获胜/.test(text))SFX.play('win');
      else if(/平局|和棋/.test(text))SFX.play('woodCheck');
      else if(/赢|获胜|胜/.test(text))SFX.play('lose');
    },
    // 翻牌游戏共用：kind = flip | move | capture | boom
    // 走子有 0.45 秒滑动动画，落地声等动画到位再响
    dirt:function(kind){
      if(kind==='flip'){SFX.play('dirtFlip');return;}
      SFX.play('dirtSlide');
      SFX.play(kind==='capture'?'dirtThud':kind==='boom'?'dirtBoom':'dirtPlace',0.42);
    },
    isMuted:function(){return muted;},
    setMuted:function(m){
      muted=!!m;
      try{localStorage.setItem('sfx_muted',muted?'1':'0');}catch(e){}
      if(btn)btn.textContent=muted?'🔇':'🔊';
    }
  };
  window.SFX=SFX;

  // ---------- 静音按钮 ----------
  var btn=null;
  function mount(){
    if(btn||!document.body)return;
    btn=document.createElement('button');
    btn.type='button';
    btn.setAttribute('aria-label','声音开关');
    btn.textContent=muted?'🔇':'🔊';
    btn.style.cssText='position:fixed;left:10px;bottom:10px;z-index:9999;width:34px;height:34px;border-radius:50%;opacity:.7;'+
      'border:none;background:rgba(0,0,0,.35);color:#fff;font-size:16px;line-height:34px;padding:0;cursor:pointer;'+
      '-webkit-tap-highlight-color:transparent;touch-action:manipulation';
    btn.addEventListener('click',function(e){
      e.stopPropagation();
      SFX.setMuted(!muted);
      if(!muted)SFX.play('dirtTap');
    });
    document.body.appendChild(btn);
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',mount);
  else mount();
})();
