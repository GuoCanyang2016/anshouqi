/* ============================================================================
 * netplay.js — 网页小游戏 P2P 开房间双人对战（无自建服务器）
 *
 * 信令：MQTT over WSS，连 EMQX 公共免费 broker（wss://broker.emqx.io:8084/mqtt）
 * 数据：WebRTC DataChannel 点对点直连（公共 STUN 打洞），走子不经过服务器
 * 依赖：mqtt.js（CDN），挂载为全局 mqtt
 *
 * 用法：
 *   Netplay.chooseMode(cb)          // cb('ai' | 'net')
 *   Netplay.lobby(gameId, opts)     // opts: {getSnapshot, onReady(sess,role,re),
 *                                   //        onOp(op), onState(state,rematch),
 *                                   //        onClose(), onError(msg), onCancel(), onRematch()}
 *   Netplay.showDisconnect(onReconnect, onGiveUp)
 * ========================================================================== */
(function(global){
'use strict';

var MQTT_URL   = 'wss://broker.emqx.io:8084/mqtt';
var TOPIC_BASE = 'anshouqi/room/';
var STUN_URL   = 'stun:stun.l.google.com:19302';
var DC_LABEL   = 'game';
var HELLO_RETRY_MS   = 2500;
var HOST_STATE_BACKUP_MS = 2000;
var MQTT_TIMEOUT_MS  = 12000;
var JOIN_TIMEOUT_MS  = 20000;

/* ================= 纯函数（可单元测试） ================= */

function genRoomCode(){
  return String(Math.floor(Math.random()*900000)+100000);
}
function genPeerId(){
  return 'p'+Math.random().toString(36).slice(2,10)+Date.now().toString(36).slice(-4);
}
function roomTopic(gameId, code){
  return TOPIC_BASE + gameId + '/' + code;
}
function encodeMsg(o){ return JSON.stringify(o); }
function decodeMsg(s){
  try{
    var o = JSON.parse(s);
    return (o && typeof o === 'object') ? o : null;
  }catch(e){ return null; }
}
var __opSeq = 0;
function stampOp(op){
  __opSeq++;
  op._opid = genPeerId() + '-' + Date.now().toString(36) + '-' + (__opSeq);
  return op;
}
function OpDedup(limit){
  this.limit = limit || 200;
  this.seen = {};
  this.order = [];
}
OpDedup.prototype.isNew = function(id){
  if(!id) return true;
  if(this.seen[id]) return false;
  this.seen[id] = 1;
  this.order.push(id);
  if(this.order.length > this.limit){
    var old = this.order.shift();
    delete this.seen[old];
  }
  return true;
};
/* 信令消息：{from, t:'hello'|'offer'|'answer'|'ice', ...} */
function sigMsg(peerId, t, extra){
  var m = {from: peerId, t: t};
  if(extra) for(var k in extra){ if(extra.hasOwnProperty(k)) m[k] = extra[k]; }
  return m;
}
function isForeignMsg(m, myId){
  return !!(m && m.from && m.from !== myId);
}
function validRoomCode(code){
  return /^\d{6}$/.test(String(code == null ? '' : code).trim());
}

/* ================= 会话 ================= */

function createSession(gameId, role, roomCode, opts){
  opts = opts || {};
  var peerId = genPeerId();
  var topic = roomTopic(gameId, roomCode);
  var mqttClient = null, pc = null, dc = null;
  var dedup = new OpDedup();
  var helloTimer = null, backupTimer = null, joinTimer = null, helloIv = null;
  var handshaking = false;
  var everConnected = false;
  var userClosed = false;
  var closeNotified = false;

  var sess = {
    role: role,
    roomCode: roomCode,
    open: false,
    gotState: (role === 'host'),
    needState: (role === 'guest'),
    send: function(o){
      if(dc && dc.readyState === 'open'){ dc.send(encodeMsg(o)); }
    },
    sendOp: function(op){ stampOp(op); this.send({kind:'op', op:op}); },
    close: function(){ userClosed = true; cleanup(); },
    reconnect: reconnect
  };

  function signal(txt){ if(opts.onSignal) opts.onSignal(txt); }
  function fail(code){ if(opts.onError) opts.onError(code); }
  function notifyClose(){
    if(closeNotified || userClosed) return;
    closeNotified = true;
    if(opts.onClose) opts.onClose();
  }

  function cleanup(){
    if(helloTimer){ clearInterval(helloTimer); helloTimer = null; }
    if(backupTimer){ clearTimeout(backupTimer); backupTimer = null; }
    if(joinTimer){ clearTimeout(joinTimer); joinTimer = null; }
    if(helloIv){ clearInterval(helloIv); helloIv = null; }
    try{ if(dc) dc.close(); }catch(e){}
    try{ if(pc) pc.close(); }catch(e){}
    try{ if(mqttClient) mqttClient.end(); }catch(e){}
    dc = null; pc = null;
    sess.open = false;
  }

  function mqttPub(o){
    if(mqttClient && mqttClient.connected){
      try{ mqttClient.publish(topic, encodeMsg(o)); }catch(e){}
    }
  }

  function newPC(){
    var RTCPC = global.RTCPeerConnection || global.webkitRTCPeerConnection;
    if(!RTCPC){ fail('webrtc-unsupported'); return null; }
    var p = new RTCPC({iceServers:[{urls:STUN_URL}]});
    p.onicecandidate = function(e){
      if(e.candidate) mqttPub(sigMsg(peerId, 'ice', {candidate: e.candidate}));
    };
    p.onconnectionstatechange = function(){
      var st = p.connectionState;
      if((st === 'failed' || st === 'disconnected' || st === 'closed') && sess.open){
        sess.open = false;
        notifyClose();
      }
    };
    if(role === 'host'){
      dc = p.createDataChannel(DC_LABEL);
      wireDC();
    }else{
      p.ondatachannel = function(e){ dc = e.channel; wireDC(); };
    }
    return p;
  }

  function wireDC(){
    dc.onopen = function(){
      sess.open = true;
      handshaking = false;
      if(joinTimer){ clearTimeout(joinTimer); joinTimer = null; }
      var re = everConnected;
      everConnected = true;
      if(role === 'guest'){
        sendHello();
        if(helloTimer) clearInterval(helloTimer);
        helloTimer = setInterval(function(){
          if(sess.needState) sendHello();
        }, HELLO_RETRY_MS);
      }else{
        if(backupTimer) clearTimeout(backupTimer);
        backupTimer = setTimeout(function(){
          if(sess.open && opts.getSnapshot) sess.send({kind:'state', state: opts.getSnapshot()});
        }, HOST_STATE_BACKUP_MS);
      }
      signal('已连接');
      if(opts.onReady) opts.onReady(sess, role, re);
    };
    dc.onmessage = function(e){
      var m = decodeMsg(typeof e.data === 'string' ? e.data : '');
      if(m) handleDC(m);
    };
    dc.onclose = function(){
      if(sess.open){
        sess.open = false;
        notifyClose();
      }
    };
  }

  function sendHello(){ sess.send({kind:'hello'}); }

  function handleDC(m){
    if(m.kind === 'op'){
      var op = m.op || {};
      if(dedup.isNew(op._opid) && opts.onOp) opts.onOp(op);
    }else if(m.kind === 'state'){
      sess.gotState = true;
      if(helloTimer){ clearInterval(helloTimer); helloTimer = null; }
      if(sess.needState || m.rematch){
        sess.needState = false;
        if(opts.onState) opts.onState(m.state, !!m.rematch);
      }
    }else if(m.kind === 'hello'){
      if(role === 'host' && opts.getSnapshot){
        sess.send({kind:'state', state: opts.getSnapshot()});
      }
    }else if(m.kind === 'rematch'){
      if(opts.onRematch) opts.onRematch();
    }else if(m.kind === 'bye'){
      notifyClose();
    }
  }

  function onSigMsg(m){
    if(m.t === 'hello'){
      if(role === 'host' && !sess.open && !handshaking) makeOffer();
    }else if(m.t === 'offer'){
      if(role === 'guest') acceptOffer(m.sdp);
    }else if(m.t === 'answer'){
      if(role === 'host' && pc && !sess.open && m.sdp){
        pc.setRemoteDescription(m.sdp).catch(function(){});
      }
    }else if(m.t === 'ice'){
      if(pc && m.candidate){
        pc.addIceCandidate(m.candidate).catch(function(){});
      }
    }
  }

  function makeOffer(){
    handshaking = true;
    pc = newPC();
    if(!pc){ handshaking = false; return; }
    pc.createOffer().then(function(offer){
      return pc.setLocalDescription(offer);
    }).then(function(){
      mqttPub(sigMsg(peerId, 'offer', {sdp: pc.localDescription}));
      signal('等待对方加入…');
    }).catch(function(){
      handshaking = false;
      fail('webrtc-fail');
    });
  }

  function acceptOffer(sdp){
    if(!sdp) return;
    handshaking = true;
    pc = newPC();
    if(!pc){ handshaking = false; return; }
    pc.setRemoteDescription(sdp).then(function(){
      return pc.createAnswer();
    }).then(function(ans){
      return pc.setLocalDescription(ans);
    }).then(function(){
      mqttPub(sigMsg(peerId, 'answer', {sdp: pc.localDescription}));
    }).catch(function(){
      handshaking = false;
      fail('webrtc-fail');
    });
  }

  function reconnect(){
    if(userClosed) return;
    closeNotified = false;
    sess.open = false;
    sess.needState = (role === 'guest');
    sess.gotState = (role === 'host');
    handshaking = false;
    try{ if(dc) dc.close(); }catch(e){}
    try{ if(pc) pc.close(); }catch(e){}
    dc = null; pc = null;
    signal('正在重新连接…');
    if(role === 'guest') mqttPub(sigMsg(peerId, 'hello', {}));
    /* 房主：等对方的 hello（走 MQTT）后再 makeOffer */
  }

  function start(){
    if(typeof global.mqtt === 'undefined'){ fail('no-mqtt'); return sess; }
    if(!(global.RTCPeerConnection || global.webkitRTCPeerConnection)){ fail('webrtc-unsupported'); return sess; }
    var done = false;
    function finish(errCode){
      if(done) return; done = true;
      if(errCode){ fail(errCode); }
      else{
        if(role === 'guest'){
          mqttPub(sigMsg(peerId, 'hello', {}));
          var tries = 0;
          helloIv = setInterval(function(){
            if(sess.open || userClosed || tries >= 4){ clearInterval(helloIv); helloIv = null; return; }
            tries++;
            mqttPub(sigMsg(peerId, 'hello', {}));
          }, 3000);
          joinTimer = setTimeout(function(){
            if(!sess.open && !userClosed) fail('join-timeout');
          }, JOIN_TIMEOUT_MS);
          signal('正在连接对方…');
        }else{
          signal('等待对方加入…');
        }
      }
    }
    try{
      mqttClient = global.mqtt.connect(MQTT_URL, {connectTimeout: 8000, reconnectPeriod: 3000});
    }catch(e){ finish('mqtt-fail'); return sess; }
    mqttClient.on('connect', function(){
      try{
        mqttClient.subscribe(topic, function(err){ finish(err ? 'mqtt-fail' : null); });
      }catch(e){ finish('mqtt-fail'); }
    });
    mqttClient.on('error', function(){ finish('mqtt-fail'); });
    mqttClient.on('message', function(tp, payload){
      if(tp !== topic) return;
      var m = decodeMsg(payload.toString());
      if(isForeignMsg(m, peerId)) onSigMsg(m);
    });
    setTimeout(function(){ finish('mqtt-fail'); }, MQTT_TIMEOUT_MS);
    return sess;
  }

  return {session: sess, start: start};
}

/* ================= UI ================= */

var modalEl = null;
function overlayCss(){
  return 'position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.72);';
}
function cardCss(){
  return 'background:#23232e;border-radius:14px;padding:28px 26px;width:min(88vw,340px);text-align:center;color:#fff;box-shadow:0 8px 30px rgba(0,0,0,.5);';
}
function btnCss(primary){
  return 'display:block;width:100%;margin:10px 0;padding:13px;font-size:17px;border:none;border-radius:10px;cursor:pointer;' +
    (primary ? 'background:#e94560;color:#fff;font-weight:bold;' : 'background:#35354a;color:#fff;');
}
function closeModal(){ if(modalEl){ modalEl.remove(); modalEl = null; } }
function openModal(html){
  closeModal();
  modalEl = document.createElement('div');
  modalEl.id = 'np-modal';
  modalEl.style.cssText = overlayCss();
  modalEl.innerHTML = '<div style="' + cardCss() + '">' + html + '</div>';
  document.body.appendChild(modalEl);
  return modalEl;
}
function npErr(msg){
  var e = modalEl && modalEl.querySelector('#np-err');
  if(e){ e.textContent = msg; e.style.display = 'block'; }
}
function errText(code){
  switch(code){
    case 'no-mqtt': return '网络组件加载失败，请检查网络后重试';
    case 'mqtt-fail': return '连不上信令服务器，请检查网络后重试';
    case 'join-timeout': return '没找到该房间，请检查房间号';
    case 'webrtc-fail': return '建立点对点连接失败，请重试';
    case 'webrtc-unsupported': return '当前浏览器不支持点对点对战';
    default: return '连接失败，请重试';
  }
}

function chooseMode(cb){
  var m = openModal(
    '<div style="font-size:20px;font-weight:bold;margin-bottom:6px;">开始游戏</div>' +
    '<div style="color:#aaa;font-size:13px;margin-bottom:8px;">选一种玩法</div>' +
    '<button id="np-ai" style="' + btnCss(true) + '">🤖 和 AI 玩</button>' +
    '<button id="np-net" style="' + btnCss(false) + '">👥 和朋友玩</button>'
  );
  m.querySelector('#np-ai').onclick = function(){ closeModal(); cb('ai'); };
  m.querySelector('#np-net').onclick = function(){ cb('net'); };
}

function lobby(gameId, opts){
  opts = opts || {};
  var cur = null; /* {session,start} */

  function showStart(){
    var m = openModal(
      '<div style="font-size:20px;font-weight:bold;margin-bottom:4px;">👥 和朋友玩</div>' +
      '<div style="color:#aaa;font-size:13px;margin-bottom:8px;">房间号连线，走子点对点直传</div>' +
      '<button id="np-create" style="' + btnCss(true) + '">创建房间</button>' +
      '<input id="np-code" inputmode="numeric" maxlength="6" placeholder="输入 6 位房间号" ' +
        'style="width:100%;padding:12px;font-size:18px;text-align:center;letter-spacing:6px;border-radius:10px;border:1px solid #555;background:#1a1a24;color:#fff;margin-top:4px;box-sizing:border-box;">' +
      '<button id="np-join" style="' + btnCss(false) + '">加入房间</button>' +
      '<button id="np-back" style="' + btnCss(false) + 'background:transparent;color:#aaa;font-size:14px;">返回</button>' +
      '<div id="np-err" style="display:none;color:#ff7b7b;font-size:13px;margin-top:6px;"></div>'
    );
    m.querySelector('#np-create').onclick = doCreate;
    m.querySelector('#np-join').onclick = doJoin;
    m.querySelector('#np-back').onclick = function(){ closeModal(); if(opts.onCancel) opts.onCancel(); };
  }

  function showWaiting(code, isHost){
    openModal(
      '<div style="font-size:16px;color:#aaa;">' + (isHost ? '房间号' : '正在加入') + '</div>' +
      '<div style="font-size:52px;font-weight:bold;letter-spacing:10px;margin:12px 0;color:#ffd76a;">' + code + '</div>' +
      '<div id="np-status" style="font-size:14px;color:#aaa;min-height:20px;">' + (isHost ? '等待对方加入…' : '连接中…') + '</div>' +
      '<div style="font-size:12px;color:#777;margin-top:8px;">把房间号发给对方即可</div>' +
      '<button id="np-cancel" style="' + btnCss(false) + '">取消</button>' +
      '<div id="np-err" style="display:none;color:#ff7b7b;font-size:13px;margin-top:6px;"></div>'
    ).querySelector('#np-cancel').onclick = function(){
      if(cur){ cur.session.close(); cur = null; }
      showStart();
    };
  }

  function sessOpts(){
    return {
      getSnapshot: opts.getSnapshot,
      onSignal: function(txt){
        var s = modalEl && modalEl.querySelector('#np-status');
        if(s) s.textContent = txt;
      },
      onReady: function(sess, role, re){
        closeModal();
        if(opts.onReady) opts.onReady(sess, role, re);
      },
      onOp: opts.onOp,
      onState: opts.onState,
      onClose: opts.onClose,
      onError: function(code){
        npErr(errText(code));
        if(opts.onError) opts.onError(code);
      }
    };
  }

  function doCreate(){
    if(typeof global.mqtt === 'undefined'){ npErr(errText('no-mqtt')); return; }
    var code = genRoomCode();
    showWaiting(code, true);
    cur = createSession(gameId, 'host', code, sessOpts());
    cur.start();
  }
  function doJoin(){
    var inp = modalEl.querySelector('#np-code');
    var code = (inp.value || '').trim();
    if(!validRoomCode(code)){ npErr('请输入 6 位数字房间号'); return; }
    if(typeof global.mqtt === 'undefined'){ npErr(errText('no-mqtt')); return; }
    showWaiting(code, false);
    cur = createSession(gameId, 'guest', code, sessOpts());
    cur.start();
  }
  showStart();
}

function showDisconnect(onReconnect, onGiveUp){
  var m = openModal(
    '<div style="font-size:20px;font-weight:bold;margin-bottom:8px;">⚠️ 对方断开连接</div>' +
    '<div style="color:#aaa;font-size:13px;margin-bottom:8px;">可能是网络波动，可以试试重连</div>' +
    '<button id="np-re" style="' + btnCss(true) + '">重新连接</button>' +
    '<button id="np-quit" style="' + btnCss(false) + '">回单机模式</button>'
  );
  m.querySelector('#np-re').onclick = function(){ closeModal(); onReconnect(); };
  m.querySelector('#np-quit').onclick = function(){ closeModal(); onGiveUp(); };
}

global.Netplay = {
  chooseMode: chooseMode,
  lobby: lobby,
  showDisconnect: showDisconnect,
  _t: {
    genRoomCode: genRoomCode,
    genPeerId: genPeerId,
    roomTopic: roomTopic,
    encodeMsg: encodeMsg,
    decodeMsg: decodeMsg,
    stampOp: stampOp,
    OpDedup: OpDedup,
    sigMsg: sigMsg,
    isForeignMsg: isForeignMsg,
    validRoomCode: validRoomCode,
    createSession: createSession
  }
};

})(typeof window !== 'undefined' ? window : this);
