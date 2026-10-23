(function installVoiceExplain(){
  'use strict';
  if(window.__qzVoiceExplainInstalled) return;
  window.__qzVoiceExplainInstalled = true;

  /* ---------- 0. 常量 ---------- */
  var ZONES = { gk:1, mk:1, sy:1 };            // 与 REVIEW_ZONES 白名单一致：申论/综应/面试不出现
  var CFG_KEY = 'qz_voice_tts_config';
  var CACHE_PREFIX = 'en_voice_explain_';
  var CACHE_DB = 'qz_voice_cache_db';
  var CACHE_STORE = 'explain';
  var CACHE_VER = 1;
  var AI_TIMEOUT = 25000;                      // AI 口语稿硬超时：到点就走原解析兜底，不无限转圈
  var EDGE_TIMEOUT = 20000;                    // 第三方 TTS 硬超时：到点降级 browser

  /* ---------- 1. 配置 ---------- */
  var VOLC_DEFAULT_VOICE = 'zh_female_vv_uranus_bigtts';   // 豆包语音合成 2.0 稳定女声
  var VOLC_LEGACY_VOICE = 'zh_female_wanwanxiaohe_moon_bigtts';  // 旧默认（1.0 音色）
  var voiceTtsConfig = {
    provider: 'browser',                       // 'browser' | 'edge' | 'volc'
    edgeUrl: '',                               // Cloudflare Worker 网关地址（POST {text, voice} → audio/*）
    edgeVoice: 'zh-CN-XiaoxiaoNeural',         // Edge TTS 音色
    volcApiKey: '',                            // 火山：新版控制台 API Key —— 现在只填这一个就够了（不需要 AppID）
    volcAppId: '',                             // 火山：旧版控制台 AppID（与 Access Token 配套，可选，留空即用新版 Key）
    volcToken: '',                             // 火山：旧版控制台 Access Token
    volcResourceId: 'seed-tts-2.0',            // 火山：模型版本 seed-tts-2.0 / seed-tts-1.0
    volcVoice: VOLC_DEFAULT_VOICE,             // 火山：音色 speaker（必须与上面的版本匹配）
    prefetch: true                             // 简化解析后自动预生成语音稿（多一次 AI 调用，换秒播）
  };
  var VOICE_CFG_FIELDS = ['edgeUrl', 'edgeVoice', 'volcApiKey', 'volcAppId', 'volcToken', 'volcResourceId', 'volcVoice'];

  function loadVoiceTtsConfig(){
    try{
      var raw = localStorage.getItem(CFG_KEY);
      if(!raw) return;
      var obj = JSON.parse(raw);
      if(!obj || typeof obj !== 'object') return;
      if(obj.provider === 'edge' || obj.provider === 'volc' || obj.provider === 'browser') voiceTtsConfig.provider = obj.provider;
      VOICE_CFG_FIELDS.forEach(function(k){
        if(typeof obj[k] === 'string') voiceTtsConfig[k] = obj[k];
      });
      if(typeof obj.prefetch === 'boolean') voiceTtsConfig.prefetch = obj.prefetch;
    }catch(e){ console.warn('[VOICE] 读取语音配置失败：', e && (e.message || e)); }
  }
  function saveVoiceTtsConfig(){
    try{ localStorage.setItem(CFG_KEY, JSON.stringify(voiceTtsConfig)); }
    catch(e){ console.warn('[VOICE] 保存语音配置失败：', e && (e.message || e)); }
  }
  loadVoiceTtsConfig();
  // 迁移：旧版把默认音色写成 1.0 的 zh_female_wanwanxiaohe_moon_bigtts，配 seed-tts-2.0 会直接合成失败。
  // 只有"还是那个旧默认值"时才升级，用户真填过的音色一律不动。
  if(voiceTtsConfig.volcVoice === VOLC_LEGACY_VOICE) voiceTtsConfig.volcVoice = VOLC_DEFAULT_VOICE;
  if(!voiceTtsConfig.volcResourceId) voiceTtsConfig.volcResourceId = 'seed-tts-2.0';

  /* ---------- 2. 图标（三态三份 SVG，尺寸/线宽与 .q-copy-btn 的剪贴板图标一致） ---------- */
  var SVG_ATTR = 'width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"'
               + ' stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"';
  var ICON_IDLE  = '<svg ' + SVG_ATTR + '><path d="M4 14.5v-2.5a8 8 0 0 1 16 0v2.5"/>'
                 + '<rect x="2.6" y="13.6" width="4.6" height="7" rx="1.9"/>'
                 + '<rect x="16.8" y="13.6" width="4.6" height="7" rx="1.9"/></svg>';
  var ICON_PAUSE = '<svg ' + SVG_ATTR + '><path d="M9.4 5.6v12.8M14.6 5.6v12.8"/></svg>';
  var ICON_PLAY  = '<svg ' + SVG_ATTR + '><path d="M8.4 5.6l9.6 6.4-9.6 6.4z"/></svg>';

  /* ---------- 3. 运行时状态（同一时间只允许一题在播） ---------- */
  var voiceState = { key:null, status:'idle', text:'', source:'', audio:null, objectUrl:null, utterance:null };
  var playToken = 0;                            // 播放会话令牌：任何异步回来先验令牌，过期直接丢弃

  // 轻提示：必须是**用户可见**的。实测本工程里没有全局 mlToast（typeof mlToast === 'undefined'，
  // 它被包在素材库的 IIFE 里），所以这里优先用全局同名函数，缺了就自建一个非阻塞 toast。
  // 不用 alert：同步模态弹窗会打断语音合成与背景音。
  var toastEl = null, toastTimer = 0;
  function toast(msg){
    try{
      if(typeof window.mlToast === 'function'){ window.mlToast(msg); return; }
    }catch(e){}
    try{
      if(!toastEl || !toastEl.parentNode){
        toastEl = document.createElement('div');
        toastEl.className = 'qz-voice-toast';
        toastEl.style.cssText = 'position:fixed;left:50%;top:18px;transform:translateX(-50%);z-index:100050;'
          + 'background:rgba(30,41,59,.94);color:#fff;padding:9px 16px;border-radius:10px;font-size:13px;'
          + 'line-height:1.45;max-width:78vw;box-shadow:0 6px 22px rgba(0,0,0,.25);pointer-events:none;'
          + 'opacity:0;transition:opacity .2s ease;';
        document.body.appendChild(toastEl);
      }
      toastEl.textContent = msg;
      toastEl.style.opacity = '1';
      clearTimeout(toastTimer);
      toastTimer = setTimeout(function(){ if(toastEl) toastEl.style.opacity = '0'; }, 2200);
    }catch(e){ console.log('[VOICE] ' + msg); }
  }
  function setStatus(status){
    voiceState.status = status;
    refreshButtons();
  }
  function refreshButtons(){
    document.querySelectorAll('.q-voice-btn').forEach(function(btn){
      var key = btn.getAttribute('data-key') || '';
      var status = (voiceState.key && key === voiceState.key) ? voiceState.status : 'idle';
      renderBtn(btn, status);
    });
  }
  function renderBtn(btn, status){
    if(!btn) return;
    if(btn._vStatus === status) return;         // 幂等：状态没变就不碰 DOM（避免 MutationObserver 自激）
    btn._vStatus = status;
    btn.innerHTML = status === 'playing' ? ICON_PAUSE : (status === 'paused' ? ICON_PLAY : ICON_IDLE);
    btn.classList.toggle('is-playing', status === 'playing');
    btn.classList.toggle('is-paused', status === 'paused');
    btn.classList.toggle('is-loading', status === 'loading');
    btn.setAttribute('aria-pressed', status === 'playing' ? 'true' : 'false');
    var label = status === 'playing' ? '暂停讲解' : (status === 'paused' ? '继续讲解' : '🎧 讲解');
    btn.title = label;
    btn.setAttribute('aria-label', label);
  }

  /* ---------- 4. 停止 / 暂停 / 继续 ---------- */
  function voiceStop(){
    playToken++;                                // 作废所有在途异步
    if(streamCtrl){ try{ streamCtrl.abort(); }catch(e){} streamCtrl = null; }   // 掐断在途的流式请求
    try{ if(window.speechSynthesis) window.speechSynthesis.cancel(); }catch(e){}
    releaseAudio();
    voiceState.key = null; voiceState.text = ''; voiceState.source = '';
    voiceState.status = 'idle'; voiceState.utterance = null;
    refreshButtons();
  }
  function releaseAudio(){
    if(voiceState.audio){
      try{ voiceState.audio.pause(); }catch(e){}
      try{ voiceState.audio.removeAttribute('src'); }catch(e){}
      try{ voiceState.audio.load(); }catch(e){}
      voiceState.audio = null;
    }
    if(voiceState.objectUrl){
      try{ URL.revokeObjectURL(voiceState.objectUrl); }catch(e){}
      voiceState.objectUrl = null;
    }
  }
  function pausePlayback(){
    if(voiceState.status !== 'playing') return;
    if(voiceState.audio){ try{ voiceState.audio.pause(); }catch(e){} }
    else if(window.speechSynthesis){ try{ window.speechSynthesis.pause(); }catch(e){} }
    setStatus('paused');
  }
  function resumePlayback(){
    if(voiceState.status !== 'paused') return;
    if(voiceState.audio){
      var p = voiceState.audio.play();
      if(p && typeof p.catch === 'function') p.catch(function(){ voiceStop(); });
      setStatus('playing');
      return;
    }
    var synth = window.speechSynthesis;
    if(!synth) return;
    try{ synth.resume(); }catch(e){}
    setStatus('playing');
    // 某些浏览器（Android Chrome / 部分 WebView）resume() 无效：pause 之后队列已经空了。
    // 这里 400ms 后复核一次，仍然没在说也没排队 → 从头重播，保证「继续」不变成静默失败。
    var token = playToken, text = voiceState.text, key = voiceState.key;
    setTimeout(function(){
      if(token !== playToken || voiceState.status !== 'playing') return;
      if(synth.speaking || synth.pending) return;
      console.warn('[VOICE] resume 无效，从头重播');
      voiceState.key = key;
      // 流式播放时 voiceState.text 还没攒完（或仍是空），此时没有可重播的全文 → 重跑链路（多半已命中缓存）
      if(text) startSpeak(key, text, voiceState.source);
      else startExplain(key);
    }, 400);
  }

  /* ---------- 5. TTS 播放层：browser / edge / volc ---------- */
  function speakBrowser(text, token){
    return new Promise(function(resolve, reject){
      if(!window.speechSynthesis || typeof window.SpeechSynthesisUtterance !== 'function'){
        reject(new Error('当前浏览器不支持语音合成'));
        return;
      }
      var u = new SpeechSynthesisUtterance(text);
      u.lang = 'zh-CN';
      u.rate = 1.0;
      u.pitch = 1.02;
      u.volume = 1;
      var voice = null;
      try{ voice = getBestChineseVoice(); }catch(e){ voice = null; }
      if(voice) u.voice = voice;
      u.onend = function(){ resolve('ended'); };
      u.onerror = function(ev){
        var code = (ev && ev.error) || 'unknown';
        if(code === 'canceled' || code === 'interrupted'){ resolve('canceled'); return; }
        reject(new Error('语音合成失败：' + code));
      };
      voiceState.utterance = u;
      try{ window.speechSynthesis.speak(u); }
      catch(err){ reject(err); }
    });
  }

  // Edge TTS：POST 到用户自建的 Cloudflare Worker，拿音频 blob 播。
  // 契约：请求 {text, voice}，响应 Content-Type: audio/*；任何非音频一律抛错交给上层降级。
  // 单次 POST（带超时）。contentType 决定会不会触发 CORS 预检：
  //   application/json → 预检 OPTIONS；text/plain → 「简单请求」，不预检。
  function postTts(url, body, contentType){
    var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = setTimeout(function(){ if(ctrl) ctrl.abort(); }, EDGE_TIMEOUT);
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': contentType },
      body: body,
      signal: ctrl ? ctrl.signal : undefined
    }).then(function(r){ clearTimeout(timer); return r; }, function(e){ clearTimeout(timer); throw e; });
  }

  function fetchEdgeAudio(text){
    var url = String(voiceTtsConfig.edgeUrl || '').trim();
    if(!url) return Promise.reject(new Error('未配置 Edge TTS Worker 地址'));
    if(!/^https?:\/\//i.test(url)) return Promise.reject(new Error('Edge TTS 地址格式不合法'));
    if(typeof fetch !== 'function') return Promise.reject(new Error('当前环境不支持 fetch'));
    var body = JSON.stringify({ text: text, voice: voiceTtsConfig.edgeVoice || 'zh-CN-XiaoxiaoNeural' });
    // 实测：自带 Worker 往往不处理 OPTIONS，application/json 的预检会直接失败
    // （控制台只报 Failed to fetch）。所以失败后立刻用 text/plain 重试 —— 简单请求不过预检。
    var request = postTts(url, body, 'application/json').catch(function(err){
      console.warn('[VOICE] Edge TTS 预检/首请求失败，改用简单请求重试：', err && (err.message || err));
      return postTts(url, body, 'text/plain;charset=UTF-8');
    });
    return request.then(function(resp){
      if(!resp || !resp.ok) throw new Error('TTS 服务返回 HTTP ' + ((resp && resp.status) || '?'));
      var ct = '';
      try{ ct = String(resp.headers.get('content-type') || '').toLowerCase(); }catch(e){}
      return resp.blob().then(function(blob){
        var looksAudio = ct.indexOf('audio') !== -1 || ct.indexOf('octet-stream') !== -1 || ct.indexOf('mpeg') !== -1;
        if(!looksAudio) throw new Error('返回内容不是音频（content-type: ' + (ct || '空') + '）');
        if(!blob || blob.size < 1024) throw new Error('音频数据为空');
        return blob;
      });
    }).then(function(blob){
      // 注意：超时定时器已由 postTts() 自己清理，这里不能再碰 timer/ctrl（会 ReferenceError）。
      return URL.createObjectURL(blob);
    });
  }

  function playObjectUrl(objUrl){
    return new Promise(function(resolve, reject){
      var audio = new Audio(objUrl);
      audio.preload = 'auto';
      voiceState.audio = audio;
      voiceState.objectUrl = objUrl;
      audio.onended = function(){ resolve('ended'); };
      audio.onerror = function(){ reject(new Error('音频解码/播放失败')); };
      var p = audio.play();
      if(p && typeof p.then === 'function'){
        p.then(null, function(err){
          // 自动播放策略拦截（请求耗时超过用户手势有效期）也会落到这里
          reject(new Error('浏览器拒绝播放：' + ((err && err.name) || 'NotAllowedError')));
        });
      }
    });
  }

  /* ---------- 5c. 火山引擎（豆包语音）v3 单向流式 HTTP 合成 ----------
     [VOICE 2026-10-23b] 控制台改版后**新版只要一个 API Key**（X-Api-Key），
     不再需要 AppID / Access Token / cluster —— 旧版的 v1 接口（appid+token+cluster+Authorization: Bearer;）
     已经不是推荐姿势，这里按新版 v3 实现，同时兼容旧版双头。

     浏览器直连的三个硬约束（2026-10-23 实测，均已验证过）：
       1) 网关回 `access-control-allow-origin: *`，跨域本身是放开的；
       2) 但 preflight 的 allow-headers 白名单里**没有 X-Api-Key**（只有 X-Api-App-Key / X-Api-Access-Key /
          X-Api-Request-Id / X-Api-Resource-Id …），请求头硬塞 X-Api-Key 会被浏览器直接拦死；
          网关认 query 里的 api_key（不带任何凭据时报的就是 "app key not found in header or query"）,
          所以新版 Key 走 `?api_key=`；Content-Type 在白名单里，预检能过；
       3) 旧版 AppID + Access Token 正好对应白名单里的 X-Api-App-Key / X-Api-Access-Key —— 老配置照样能用。

     响应是 HTTP chunked 的 JSON Lines：{code:0,data:'<base64 mp3>'} … 收尾 {code:20000000}。
     这里把 base64 片段按顺序拼成 Blob 再交给 playObjectUrl()；任何异常都往上抛，
     由 speakWithTts() 统一 console.warn + 降级浏览器语音。 */
  var VOLC_URL = 'https://openspeech.bytedance.com/api/v3/tts/unidirectional';
  var VOLC_TIMEOUT = 20000;
  var volcHinted = false;

  function volcAuth(){
    var key = String(voiceTtsConfig.volcApiKey || '').trim();
    var appId = String(voiceTtsConfig.volcAppId || '').trim();
    var token = String(voiceTtsConfig.volcToken || '').trim();
    if(key) return { url: VOLC_URL + '?api_key=' + encodeURIComponent(key), headers: {} };
    if(appId && token) return { url: VOLC_URL, headers: { 'X-Api-App-Key': appId, 'X-Api-Access-Key': token } };
    return null;
  }

  function b64ToBytes(b64){
    var bin;
    try{ bin = window.atob(String(b64 || '')); }catch(e){ return null; }
    var n = bin.length, out = new Uint8Array(n);
    for(var i = 0; i < n; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  // 按「成对花括号」切 JSON 对象（不假设一行一个，兼容 text() 把多行粘在一起）
  function parseVolcStream(raw){
    var text = String(raw || ''), chunks = [], errMsg = '', i = 0;
    while(i < text.length){
      var start = text.indexOf('{', i);
      if(start < 0) break;
      var depth = 0, inStr = false, esc = false, end = -1;
      for(var j = start; j < text.length; j++){
        var ch = text.charAt(j);
        if(inStr){
          if(esc) esc = false;
          else if(ch === '\\') esc = true;
          else if(ch === '"') inStr = false;
        }else if(ch === '"') inStr = true;
        else if(ch === '{') depth++;
        else if(ch === '}'){ depth--; if(depth === 0){ end = j; break; } }
      }
      if(end < 0) break;                       // 残包：丢弃，不冒泡
      var obj = null;
      try{ obj = JSON.parse(text.slice(start, end + 1)); }catch(e){ obj = null; }
      i = end + 1;
      if(!obj) continue;
      var code = Number(obj.code != null ? obj.code : (obj.header && obj.header.code));
      if(code && code !== 20000000){
        errMsg = (obj.message || (obj.header && obj.header.message) || ('code ' + code));
        continue;
      }
      if(typeof obj.data === 'string' && obj.data) chunks.push(obj.data);
    }
    return { chunks: chunks, error: errMsg };
  }

  function speakVolc(text, token){
    var auth = volcAuth();
    if(!auth){
      if(!volcHinted){
        volcHinted = true;
        toast('火山引擎还没填 API Key，先用浏览器语音');
      }
      return Promise.reject(new Error('火山引擎未配置 API Key（或旧版 AppID + Access Token）'));
    }
    if(typeof fetch !== 'function') return Promise.reject(new Error('当前环境不支持 fetch'));

    var body = JSON.stringify({
      user: { uid: 'qz-voice' },
      req_params: {
        text: String(text || ''),
        speaker: String(voiceTtsConfig.volcVoice || '').trim() || VOLC_DEFAULT_VOICE,
        audio_params: { format: 'mp3', sample_rate: 24000 }
      }
    });
    var headers = {
      'Content-Type': 'application/json',
      'X-Api-Resource-Id': String(voiceTtsConfig.volcResourceId || '').trim() || 'seed-tts-2.0'
    };
    Object.keys(auth.headers).forEach(function(k){ headers[k] = auth.headers[k]; });

    var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = 0;
    if(ctrl) timer = setTimeout(function(){ try{ ctrl.abort(); }catch(e){} }, VOLC_TIMEOUT);

    return fetch(auth.url, {
      method: 'POST',
      headers: headers,
      body: body,
      signal: ctrl ? ctrl.signal : undefined
    }).then(function(resp){
      if(!resp) throw new Error('火山引擎无响应');
      return resp.text().then(function(raw){ return { resp: resp, raw: raw }; });
    }).then(function(r){
      if(timer) clearTimeout(timer);
      var parsed = parseVolcStream(r.raw);
      if(parsed.error) throw new Error('火山引擎返回错误：' + parsed.error);
      if(!parsed.chunks.length) throw new Error('火山引擎没返回音频（HTTP ' + ((r.resp && r.resp.status) || '?') + '）');

      var total = 0, i;
      var parts = [];
      for(i = 0; i < parsed.chunks.length; i++){
        var bytes = b64ToBytes(parsed.chunks[i]);
        if(bytes && bytes.length){ parts.push(bytes); total += bytes.length; }
      }
      if(!total) throw new Error('火山引擎音频解码失败');
      var merged = new Uint8Array(total), offset = 0;
      for(i = 0; i < parts.length; i++){ merged.set(parts[i], offset); offset += parts[i].length; }

      var blob = new Blob([merged], { type: 'audio/mpeg' });
      var objUrl = URL.createObjectURL(blob);
      if(token !== playToken){                     // 期间切题 / 被叫停：丢弃，别抢麦
        try{ URL.revokeObjectURL(objUrl); }catch(e){}
        return 'canceled';
      }
      return playObjectUrl(objUrl);
    }).catch(function(err){
      if(timer) clearTimeout(timer);
      throw err;
    });
  }

  // 统一入口：按 provider 分发；第三方任何失败都 console.warn 后降级 browser（不弹窗、不打断）
  function speakWithTts(text, token){
    var provider = voiceTtsConfig.provider || 'browser';
    if(provider === 'edge'){
      return fetchEdgeAudio(text).then(function(objUrl){
        if(token !== playToken){
          try{ URL.revokeObjectURL(objUrl); }catch(e){}
          return 'canceled';
        }
        return playObjectUrl(objUrl);
      }).catch(function(err){
        console.warn('[VOICE] Edge TTS 失败，已降级浏览器语音：', err && (err.message || err));
        if(token !== playToken) return 'canceled';
        releaseAudio();
        // 需求：第三方失败只 console.warn，不弹窗、不打断
        return speakBrowser(text, token);
      });
    }
    if(provider === 'volc'){
      return speakVolc(text, token).catch(function(err){
        console.warn('[VOICE] 火山引擎 TTS 失败，已降级浏览器语音：', err && (err.message || err));
        if(token !== playToken) return 'canceled';
        releaseAudio();
        return speakBrowser(text, token);
      });
    }
    return speakBrowser(text, token);            // browser：与纯浏览器语音方案完全一致
  }

  function startSpeak(key, text, source){
    var token = ++playToken;
    voiceState.key = key;
    voiceState.text = text;
    voiceState.source = source || '';
    releaseAudio();
    refreshButtons();
    setStatus('playing');
    speakWithTts(text, token).then(function(reason){
      if(token !== playToken) return;
      if(reason === 'canceled') return;
      voiceStop();
    }).catch(function(err){
      if(token !== playToken) return;
      console.warn('[VOICE] 播报失败：', err && (err.message || err));
      voiceStop();
      toast('播报失败：' + ((err && err.message) || '未知错误'));
    });
  }

  /* ---------- 6. IndexedDB 缓存 en_voice_explain_<qid> ---------- */
  var cacheDbPromise = null;
  function cacheDb(){
    if(cacheDbPromise) return cacheDbPromise;
    cacheDbPromise = new Promise(function(resolve, reject){
      if(!window.indexedDB){ reject(new Error('无 indexedDB')); return; }
      var req = indexedDB.open(CACHE_DB, CACHE_VER);
      req.onupgradeneeded = function(e){
        var d = e.target.result;
        if(!d.objectStoreNames.contains(CACHE_STORE)) d.createObjectStore(CACHE_STORE);
      };
      req.onsuccess = function(e){ resolve(e.target.result); };
      req.onerror = function(e){ reject((e.target && e.target.error) || new Error('打开缓存库失败')); };
    });
    cacheDbPromise.catch(function(){ cacheDbPromise = null; });   // 失败可重试
    return cacheDbPromise;
  }
  function cacheKey(key){ return CACHE_PREFIX + key; }
  function readCache(key){
    return cacheDb().then(function(d){
      return new Promise(function(resolve){
        var tx = d.transaction(CACHE_STORE, 'readonly');
        var req = tx.objectStore(CACHE_STORE).get(cacheKey(key));
        req.onsuccess = function(){
          var v = req.result;
          resolve(v && typeof v === 'object' && v.t ? v : null);
        };
        req.onerror = function(){ resolve(null); };
      });
    }).catch(function(){ return null; });
  }
  function writeCache(key, text, src){
    return cacheDb().then(function(d){
      return new Promise(function(resolve){
        var tx = d.transaction(CACHE_STORE, 'readwrite');
        tx.objectStore(CACHE_STORE).put({ t:text, src:src || '', at:Date.now() }, cacheKey(key));
        tx.oncomplete = function(){ resolve(true); };
        tx.onerror = function(){ resolve(false); };
      });
    }).catch(function(){ return false; });
  }

  /* ---------- 7. 取数与文本拼装（全部复用现有函数） ---------- */
  function stripTags(html){
    var s = String(html == null ? '' : html);
    if(!s) return '';
    if(typeof stripHtml === 'function'){
      try{ return stripHtml(s); }catch(e){}
    }
    return s.replace(/<img\b[^>]*>/gi, '［图片］')
            .replace(/<br\s*\/?>/gi, '\n')
            .replace(/<[^>]+>/g, '')
            .replace(/&nbsp;/gi, ' ')
            .replace(/&amp;/gi, '&')
            .replace(/\s+/g, ' ')
            .trim();
  }
  function optText(opt){
    if(opt && typeof opt === 'object') return String(opt.text || opt.content || opt.value || opt.label || opt.name || '').trim();
    return String(opt == null ? '' : opt).trim();
  }
  function answerText(item){
    try{
      var a = getCorrectLetter(item);
      if(Array.isArray(a)) return a.join('');
      return String(a == null ? '' : a).trim();
    }catch(e){ return ''; }
  }
  function optionsText(item){
    var out = [];
    try{
      (getOptions(item) || []).forEach(function(opt, i){
        var t = stripTags(optText(opt));
        if(t) out.push(String.fromCharCode(65 + i) + '. ' + t);
      });
    }catch(e){}
    return out.join(' / ');
  }
  function findItem(key){
    try{
      var list = (typeof filteredQuestions !== 'undefined' && Array.isArray(filteredQuestions)) ? filteredQuestions : [];
      var hit = list.filter(function(q){ return q && q._key === key; })[0];
      if(hit) return hit;
    }catch(e){}
    try{
      if(typeof findQuestionByKey === 'function'){
        var found = findQuestionByKey(key);
        if(found) return found;
      }
    }catch(e){}
    return null;
  }
  // 正文按需释放（C2-B 轻量壳）时，同步查不到正文 → 异步按 key 定位
  function resolveItem(key){
    var item = findItem(key);
    if(item && (item.content || item.solution)) return Promise.resolve(item);
    var asyncLoad = (typeof findQuestionByKeyAsync === 'function')
      ? Promise.resolve().then(function(){ return findQuestionByKeyAsync(key); }).catch(function(){ return null; })
      : Promise.resolve(null);
    return asyncLoad.then(function(loaded){
      if(loaded && (loaded.content || loaded.solution)) return loaded;
      return item || loaded || null;
    });
  }
  // 「已有解析」优先级：简化解析缓存（最后一条 type==='simplify'） → item.solution 原文
  function pickExistingAnalysis(key, item){
    return getAIHistory(key).then(function(messages){
      var list = Array.isArray(messages) ? messages : [];
      var simplified = null;
      for(var i = list.length - 1; i >= 0; i--){
        var m = list[i];
        if(m && m.type === 'simplify' && m.content){
          simplified = String(m.content);
          break;
        }
      }
      if(simplified) return { text: stripTags(simplified), origin: 'simplify' };
      if(item && item.solution){
        var raw = stripTags(item.solution);
        if(raw) return { text: raw, origin: 'solution' };
      }
      return { text:'', origin:'none' };
    }).catch(function(){
      if(item && item.solution) return { text: stripTags(item.solution), origin:'solution' };
      return { text:'', origin:'none' };
    });
  }

  /* ---------- 8. AI：把「已有解析」改写成口语稿（不重新解题） ---------- */
  var VOICE_SYSTEM_PROMPT = [
    '你是公考讲师，正在给学生做一对一语音讲解。你的任务是把下面给出的【已有解析】改写成适合朗读的口语稿，不是重新解题。',
    '',
    '【铁律】',
    '1. 结论绝对不许变：正确项、错误项、易错点必须与【已有解析】完全一致。',
    '2. 不许新增知识点：【已有解析】没提到的内容，一个字都不能加。',
    '3. 只允许改表达方式：把书面结构（【正确答案】【逐项分析】）改成口语叙述。',
    '',
    '【口语要求】',
    '1. 开头一句话点题："这道题考的是……"。',
    '2. 先讲正确答案为什么对，再讲最容易错的干扰项错在哪，最后一句易错提醒。',
    '3. 每句不超过 25 字，多用逗号制造停顿。',
    '4. 用口语衔接词："我们来看""注意这里""很多同学会选 C，但……""这里有个坑"。',
    '5. 不要念选项字母以外的符号，不要念"根据材料""如上所述"这类书面语。',
    '6. 全文 250~350 字，必须完整，结尾要有句号。',
    '7. 只输出讲解正文，不要标题、不要 markdown、不要任何解释。'
  ].join('\n');

  function buildUserMessage(item, existingText){
    var parts = [];
    parts.push('【题干】' + (stripTags(item && item.content) || '（题干为空）'));
    parts.push('【选项】' + (optionsText(item) || '（无选项）'));
    parts.push('【正确答案】' + (answerText(item) || '（未知）'));
    parts.push('【已有解析】\n' + String(existingText || '').slice(0, 4000));
    return parts.join('\n');
  }
  function withTimeout(promise, ms, label){
    return new Promise(function(resolve, reject){
      var done = false;
      var timer = setTimeout(function(){
        if(done) return;
        done = true;
        reject(new Error((label || '请求') + '超时'));
      }, ms);
      Promise.resolve(promise).then(function(v){
        if(done) return;
        done = true; clearTimeout(timer); resolve(v);
      }, function(e){
        if(done) return;
        done = true; clearTimeout(timer); reject(e);
      });
    });
  }
  function readAIResponse(resp){
    var content = '';
    if(resp && typeof resp === 'string') content = resp;
    else if(resp && resp.data && resp.data.choices && resp.data.choices[0] && resp.data.choices[0].message){
      content = resp.data.choices[0].message.content || '';
    }
    if(Array.isArray(content)){
      content = content.map(function(p){ return (p && (p.text || p.content)) || ''; }).join('');
    }
    return String(content || '');
  }
  // 清洗：去掉 markdown 痕迹、角色前缀、多余空行 —— 只留可朗读正文
  function cleanScript(text){
    var s = String(text || '').replace(/\r/g, '');
    s = s.replace(/^```[\s\S]*?\n/, '').replace(/```/g, '');
    s = s.replace(/^(讲解|语音讲解|口语稿|正文)[:：]\s*/m, '');
    s = s.replace(/[*#`>]/g, '');
    s = s.replace(/[ \t\u00a0]+/g, ' ');
    s = s.replace(/\n{2,}/g, '\n').trim();
    return s;
  }
  function rewriteToSpoken(item, existingText){
    var provider = (typeof aiConfig !== 'undefined' && aiConfig && aiConfig.provider) ? aiConfig.provider : '';
    if(!provider) return Promise.reject(new Error('未配置 AI 服务商'));
    var ep = (typeof AI_ENDPOINTS !== 'undefined' && AI_ENDPOINTS) ? AI_ENDPOINTS[provider] : null;
    if(!ep) return Promise.reject(new Error('未知的 AI 服务商'));
    var model = (aiConfig && aiConfig.model) || ep.model || '';
    var payload = {
      provider: provider,
      model: model,
      messages: [
        { role:'system', content: VOICE_SYSTEM_PROMPT },
        { role:'user', content: buildUserMessage(item, existingText) }
      ],
      temperature: 0.6,
      max_tokens: 1200
    };
    return withTimeout(requestAI(payload), AI_TIMEOUT, 'AI 讲解改写').then(function(resp){
      var text = cleanScript(readAIResponse(resp));
      if(!text) throw new Error('AI 返回内容为空');
      return text;
    });
  }

  /* ---------- 8b. 流式改写 + 边到边播（首句先出声，把等待压到 1~2 秒） ----------
     为什么不再整段等：一份 250~350 字的口语稿，非流式要等模型把全文吐完（实测 5~15 秒）
     才有第一个字可播。改成 SSE 流式后，每凑够一句就先念一句，用户很快就能听到
     「这道题考的是……」，后面的句子在念的同时继续生成。 */
  var streamCtrl = null;                        // 在途流式请求：voiceStop 时 abort，避免白发请求
  var CHUNK_MIN = 6, CHUNK_MAX = 46;            // 短于 6 字的碎句先攒着；超过 46 字退到逗号断开

  // 从累积缓冲区切出「可以念了」的一段，返回 [chunk, rest]
  // 规则：优先在句末标点（。！？；）断开；一整句太长时，退到最近一个逗号断；
  // 连逗号都没有（模型偶尔一口气写很长）才按硬上限切，避免出现念二十秒的超长句。
  function cutChunk(buf, final){
    if(final) return [String(buf || '').trim(), ''];
    if(!buf) return ['', ''];
    var lastBreak = -1;                             // 最近一个「至少念完半句」的逗号位置
    for(var i = 0; i < buf.length; i++){
      var ch = buf.charAt(i);
      if(i >= CHUNK_MIN && '。！？；!?;…\n'.indexOf(ch) >= 0){
        var j = i + 1;
        while(j < buf.length && '”"』」）)】'.indexOf(buf.charAt(j)) >= 0) j++;   // 连同后引号/括弧一起念
        return [buf.slice(0, j).trim(), buf.slice(j)];
      }
      if('，,、：:'.indexOf(ch) >= 0) lastBreak = i + 1;
      if(i + 1 >= CHUNK_MAX && lastBreak > CHUNK_MIN){
        return [buf.slice(0, lastBreak).trim(), buf.slice(lastBreak)];
      }
    }
    if(buf.length >= CHUNK_MAX * 2){                 // 通篇没有标点：硬切
      return [buf.slice(0, CHUNK_MAX).trim(), buf.slice(CHUNK_MAX)];
    }
    return ['', buf];
  }

  // 流式请求：只认 delta.content；reasoning_content 一律不进正文（否则会念出思考过程）
  function streamScript(item, existingText, onDelta, signal){
    var provider = (typeof aiConfig !== 'undefined' && aiConfig && aiConfig.provider) ? aiConfig.provider : '';
    var ep = (typeof AI_ENDPOINTS !== 'undefined' && AI_ENDPOINTS) ? AI_ENDPOINTS[provider] : null;
    if(!ep) return Promise.reject(new Error('未配置 AI 服务商'));
    if(!aiConfig.apiKey) return Promise.reject(new Error('未配置 API Key'));
    if(typeof fetch !== 'function') return Promise.reject(new Error('当前环境不支持 fetch'));
    var body = {
      model: (aiConfig && aiConfig.model) || ep.model || '',
      messages: [
        { role:'system', content: VOICE_SYSTEM_PROMPT },
        { role:'user', content: buildUserMessage(item, existingText) }
      ],
      temperature: 0.6,
      max_tokens: 900,                 // 250~350 字中文够用；额度小一点也能少等一点
      stream: true
    };
    return fetch(ep.url, {
      method:'POST',
      headers: (typeof aiAuthHeaders === 'function') ? aiAuthHeaders() : {'Content-Type':'application/json'},
      body: JSON.stringify(body),
      signal: signal
    }).then(function(resp){
      if(!resp || !resp.ok) throw new Error('HTTP ' + ((resp && resp.status) || '?'));
      if(!resp.body || typeof resp.body.getReader !== 'function') throw new Error('该服务不支持流式返回');
      var reader = resp.body.getReader();
      var dec = typeof TextDecoder === 'function' ? new TextDecoder('utf-8') : null;
      if(!dec) throw new Error('当前环境不支持流式解码');
      var pending = '';
      function pump(){
        return reader.read().then(function(r){
          if(r.done) return 'done';
          pending += dec.decode(r.value, { stream:true });
          var lines = pending.split('\n');
          pending = lines.pop();
          for(var i = 0; i < lines.length; i++){
            var line = String(lines[i] || '').trim();
            if(line.indexOf('data:') !== 0) continue;
            var payload = line.slice(5).trim();
            if(!payload || payload === '[DONE]') continue;
            try{
              var json = JSON.parse(payload);
              var delta = json.choices && json.choices[0] && json.choices[0].delta;
              if(delta && delta.content) onDelta(delta.content);
            }catch(e){}
          }
          return pump();
        });
      }
      return pump();
    });
  }

  /* 流式播报器：一句一个 utterance，speechSynthesis 自己排队；
     最后一句念完（且流已结束）才归位，中途不会因为队列空一下就把按钮打回 idle。 */
  function makeStreamSpeaker(token){
    var pending = 0, closed = false, started = false;
    var synth = window.speechSynthesis;
    function done(){ if(token === playToken) voiceStop(); }
    function maybeDone(){ if(closed && pending <= 0) done(); }
    function say(chunk){
      if(token !== playToken || !chunk) return;
      if(!synth || typeof window.SpeechSynthesisUtterance !== 'function') return;
      var u = new SpeechSynthesisUtterance(chunk);
      u.lang = 'zh-CN';
      u.rate = 1.0;
      u.pitch = 1.02;
      u.volume = 1;
      try{ var v = getBestChineseVoice(); if(v) u.voice = v; }catch(e){}
      pending++;
      if(!started){ started = true; setStatus('playing'); }   // 有第一句就切成「播放中」，可暂停
      voiceState.utterance = u;
      u.onend = function(){ pending--; maybeDone(); };
      u.onerror = function(){ pending--; maybeDone(); };
      try{ synth.speak(u); }catch(e){ pending--; }
    }
    return { say: say, finish: function(){ closed = true; maybeDone(); }, isStarted: function(){ return started; } };
  }

  // 流式生成 + 边到边播；完整走完才写缓存（半截稿不落库）
  function streamExplain(key, item, existing, token){
    var speaker = makeStreamSpeaker(token);
    var acc = '', buf = '', ctrl = (typeof AbortController === 'function') ? new AbortController() : null;
    streamCtrl = ctrl;
    voiceState.source = 'ai';                     // 一开始就标成 AI 稿，别等全文结束（暂停/回放要靠它判来源）
    // 卡住保护：模型中途 15 秒不出新字（掉线/被判风控/网关挂住）→ 主动 abort 收尾，
    // 不能让语音停在半句上、按钮一直转圈。
    var idleTimer = 0;
    function armIdle(){
      clearTimeout(idleTimer);
      idleTimer = setTimeout(function(){
        if(token !== playToken) return;
        console.warn('[VOICE] 流式改写 15 秒无新内容，主动收尾');
        try{ if(ctrl) ctrl.abort(); }catch(e){}
      }, 15000);
    }
    armIdle();
    var t0 = Date.now();
    var tipTimer = setTimeout(function(){
      if(token !== playToken || speaker.isStarted()) return;
      var sec = Math.round((Date.now() - t0) / 1000);
      toast('正在写讲解稿…已 ' + sec + ' 秒（同一题第二次点会秒播）');
    }, 1200);

    function feed(piece){
      armIdle();
      acc += piece;
      buf += piece;
      for(var guard = 0; guard < 40; guard++){
        var pair = cutChunk(buf, false);
        if(!pair[0]) break;
        buf = pair[1];
        speaker.say(pair[0]);
      }
    }

    return streamScript(item, existing.text, feed, ctrl ? ctrl.signal : undefined).then(function(){
      clearTimeout(tipTimer);
      clearTimeout(idleTimer);
      if(streamCtrl === ctrl) streamCtrl = null;
      if(token !== playToken) return;
      var tail = String(buf || '').trim();
      if(tail){ speaker.say(tail); buf = ''; }
      var full = cleanScript(acc);
      if(!full) throw new Error('AI 返回内容为空');
      voiceState.text = full;
      voiceState.source = 'ai';
      writeCache(key, full, existing.origin);
      speaker.finish();
    }).catch(function(err){
      clearTimeout(tipTimer);
      clearTimeout(idleTimer);
      if(streamCtrl === ctrl) streamCtrl = null;
      if(token !== playToken) return;
      // 已经出声过就不再整段重来，否则同一道题会被念两遍；只把队列收尾
      if(speaker.isStarted()){ speaker.finish(); return; }
      throw err;
    });
  }

  /* ---------- 9. 主流程 ---------- */
  function startExplain(key){
    voiceStop();
    stopSpeaking();                               // 顺手停掉「🔊 朗读」，避免两路声音叠在一起
    var token = ++playToken;
    voiceState.key = key;
    setStatus('loading');

    function alive(){ return token === playToken; }

    readCache(key).then(function(cached){
      if(!alive()) return null;
      if(cached && cached.t){                       // ① 命中缓存 → 秒播
        startSpeak(key, cached.t, cached.src || 'cache');
        return null;
      }
      return resolveItem(key).then(function(item){
        if(!alive()) return null;
        return pickExistingAnalysis(key, item).then(function(existing){
          if(!alive()) return null;
          if(!existing.text){
            voiceStop();
            toast('这道题没有可讲解的解析');
            return null;
          }
          // ③ 流式口语化改写：第一句到就先播，不等全文
          return streamExplain(key, item, existing, token).catch(function(err){
            if(!alive()) return null;
            console.warn('[VOICE] 流式改写失败，退回整段请求：', err && (err.message || err));
            // ③' 流式不可用（服务不支持 SSE / 断流 / 环境无 TextDecoder）→ 退回整段 requestAI
            return rewriteToSpoken(item, existing.text).then(function(script){
              if(!alive()) return null;
              writeCache(key, script, existing.origin);
              startSpeak(key, script, 'ai');
            }).catch(function(err2){
              if(!alive()) return null;
              console.warn('[VOICE] AI 讲解改写失败，改用原解析播报：', err2 && (err2.message || err2));
              var reason = (err2 && err2.message) || '';
              toast(/Key|apiKey|中转/i.test(reason) ? '未配置/不可用的 AI，已用原解析播报' : 'AI 讲解失败，已用原解析播报');
              startSpeak(key, existing.text, 'raw');   // ⑤ 兜底：原解析原文
            });
          });
        });
      });
    }).catch(function(err){
      if(!alive()) return null;
      console.warn('[VOICE] 讲解流程异常：', err && (err.message || err));
      voiceStop();
      toast('讲解启动失败：' + ((err && err.message) || '未知错误'));
    });
  }

  function onVoiceClick(key, btn, ev){
    if(ev){ ev.stopPropagation(); ev.preventDefault(); }
    if(!ZONES[activeZone]) return;                // 双保险：非白名单分区不响应
    if(voiceState.key === key && voiceState.status === 'playing'){ pausePlayback(); return; }
    if(voiceState.key === key && voiceState.status === 'paused'){ resumePlayback(); return; }
    if(voiceState.key === key && voiceState.status === 'loading'){ voiceStop(); return; }
    startExplain(key);
  }

  /* ---------- 10. 按钮：幂等插入，顺序 [⭐收藏][做过N次][🎧讲解][📋复制] ---------- */
  function placeVoiceButton(questionEl, key){
    if(!questionEl || !key) return null;
    var title = questionEl.querySelector('.q-title');
    if(!title) return null;
    var btn = title.querySelector('.q-voice-btn');
    if(!ZONES[activeZone]){
      if(btn) btn.remove();
      return null;
    }
    if(!btn){
      btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'q-voice-btn';
      btn.innerHTML = ICON_IDLE;
      // 注意：不要预置 _vStatus —— renderBtn 靠它做幂等短路，预置会让 title/aria-label 永远不写。
      btn.addEventListener('click', function(ev){ onVoiceClick(btn.getAttribute('data-key') || key, btn, ev); });
    }
    if(btn.getAttribute('data-key') !== key) btn.setAttribute('data-key', key);
    var copy = title.querySelector('.q-copy-btn');
    if(copy){
      // 📋复制 已在 → 插在它前面；已在正确位置就不动（幂等，避免 MutationObserver 自激）
      // [VOICE 2026-10-23] 两者装进同一个 inline-flex 小组：360px 以下换行时 🎧 与 📋
      // 作为一个整体一起换行，不会被拆到两行（实测不分组时复制按钮会单独掉到第二行）。
      // 只挪 DOM 位置，不复制按钮、不动 📋 的事件与类名，应用侧 querySelector 照旧命中。
      var group = title.querySelector('.q-title-actions');
      if(!group || group.parentNode !== title){
        group = document.createElement('span');
        group.className = 'q-title-actions';
        title.appendChild(group);
      }
      if(copy.parentNode !== group) group.appendChild(copy);
      if(btn.parentNode !== group || btn.nextElementSibling !== copy) group.insertBefore(btn, copy);
    }else{
      // 📋复制 还没来（动态追加，时序不可控）→ 先挂末尾，下次渲染再纠正
      if(btn.parentNode !== title || title.lastElementChild !== btn) title.appendChild(btn);
    }
    renderBtn(btn, voiceState.key === key ? voiceState.status : 'idle');
    return btn;
  }

  function scan(){
    var content = document.getElementById('content');
    if(!content) return;
    content.querySelectorAll('.question').forEach(function(q){
      var key = String(q.id || '').replace(/^q-/, '');
      if(key) placeVoiceButton(q, key);
    });
    // 正在播的题已随翻页/筛选消失 → 立即停，不留残音
    if(voiceState.status !== 'idle' && voiceState.key && !document.getElementById('q-' + voiceState.key)){
      voiceStop();
    }
  }

  var scheduled = false;
  function scheduleScan(){
    if(scheduled) return;
    scheduled = true;
    // 用 setTimeout 而非 rAF：后台标签页里 rAF 会被暂停，会把 scheduled 永久卡在 true，
    // 之后再有任何 DOM 变化都扫不到（按钮就再也不会被补回来）。
    setTimeout(function(){ scheduled = false; scan(); }, 16);
  }

  /* ---------- 11. 导航拦截：包装函数（不改原函数体） ---------- */
  ['goPage', 'switchZone', 'switchFile'].forEach(function(name){
    var orig = window[name];
    if(typeof orig !== 'function') return;
    window[name] = function(){
      var result = orig.apply(this, arguments);
      voiceStop();                                // 切页 / 切分区 / 切文件 → 自动停，按钮状态归位
      scheduleScan();
      return result;
    };
  });

  /* ---------- 11b. 兜底：AI 面板最顶部那个「AI 服务商」下拉不能空着 ----------
     [VOICE 2026-10-23c] 现象（用户实录）：选了 DeepSeek，框里还是空的；但 API Key 和
     「模型」框都正常显示 deepseek-flash。原因很确定：**存档里的 provider 不是合法 option 值**
     （例如大小写不同的 'DeepSeek'、或早期版本写进去的野标识）。原生 <select> 一旦 .value 匹配
     不到任何 option，selectedIndex 就是 -1 —— 控件只画一个空框，和文字颜色、CSS 都无关。
     三层兜底，依次执行：
       ① normalizeAIProvider：大小写/空格差异 → 规范成合法键（顺手把 providerConfigs 一起搬），
          这一步还能把「AI 一直报未知服务商」的隐性故障一起修掉；
       ② 仍非法的（真·野标识）→ 补一个同名 option 让它至少能显示出来，并标注「未识别」；
       ③ 文字色与底色相同时强制深色（极端主题下的另一条成因）。
     另外保留一次强制重绘，防个别 WebView 的绘制残留。 */
  function aiProviderKeys(){
    var sel = document.getElementById('aiProvider'), keys = [], i;
    if(sel && sel.options){
      for(i = 0; i < sel.options.length; i++) keys.push(sel.options[i].value);
    }
    if(!keys.length && typeof AI_ENDPOINTS !== 'undefined' && AI_ENDPOINTS){
      keys = Object.keys(AI_ENDPOINTS);
    }
    return keys;
  }

  // 返回 true 表示把存档里的非法 provider 规范成了合法键（并已落盘）
  function normalizeAIProvider(){
    try{
      if(typeof aiConfig === 'undefined' || !aiConfig || !aiConfig.provider) return false;
      var cur = String(aiConfig.provider);
      var keys = aiProviderKeys();
      if(!keys.length || keys.indexOf(cur) >= 0) return false;      // 已合法
      var hit = '';
      for(var i = 0; i < keys.length; i++){
        if(keys[i].toLowerCase() === cur.toLowerCase().replace(/^\s+|\s+$/g, '')){ hit = keys[i]; break; }
      }
      if(!hit) return false;                                        // 规范不出来，交给 ② 显示
      aiConfig.provider = hit;
      if(aiConfig.providerConfigs && aiConfig.providerConfigs[cur]){
        if(!aiConfig.providerConfigs[hit]) aiConfig.providerConfigs[hit] = aiConfig.providerConfigs[cur];   // 密钥/模型别丢
        delete aiConfig.providerConfigs[cur];                                                              // 老键清掉，免得下次又读到
      }
      try{ localStorage.setItem('qz_ai_config', JSON.stringify(aiConfig)); }catch(e){}
      console.log('[AI] 服务商标识已规范化：' + cur + ' → ' + hit);
      return true;
    }catch(e){ return false; }
  }

  function ensureAIProviderSelected(){
    var sel = document.getElementById('aiProvider');
    if(!sel || !sel.options) return;

    normalizeAIProvider();                           // ① 先把存档值修成合法键

    if(!sel.value){                                  // ② 值不合法 → 校正 / 补 option
      var want = '';
      try{ want = (typeof aiConfig !== 'undefined' && aiConfig && aiConfig.provider) ? String(aiConfig.provider) : ''; }catch(e){}
      if(!want) want = 'deepseek';
      var keys = aiProviderKeys(), hit = false;
      for(var i = 0; i < keys.length; i++){ if(keys[i] === want){ hit = true; break; } }
      if(!hit){
        var opt = document.createElement('option');
        opt.value = want;
        opt.textContent = want + '（未识别，请重选）';
        sel.appendChild(opt);
      }
      sel.value = want;
    }

    // ③ 值对但文字可能"看不见"：自绘层（见 decorateAIProviderSelect）会处理配色，这里只兜原生部分
    try{
      var cs = window.getComputedStyle(sel);
      if(cs && cs.backgroundColor === 'rgba(0, 0, 0, 0)') sel.style.backgroundColor = '#fff';
    }catch(e){}

    repaintSelect(sel);                              // ④ 强制重绘，防 WebView 残影
  }
  // 换掉 opacity 触发重绘：不是 clone（clone 会丢 change 监听和当前值），只是让合成层失效重建
  function repaintSelect(el){
    try{
      el.style.opacity = '0.9999';
      var done = function(){ el.style.opacity = ''; };
      if(typeof requestAnimationFrame === 'function') requestAnimationFrame(function(){ requestAnimationFrame(done); });
      else setTimeout(done, 16);
    }catch(e){}
  }
  /* ---------- 11c. 「AI 服务商」自绘文字层 ----------
     [VOICE 2026-10-23d] 用户实测：语音引擎选「浏览器自带」时，顶部服务商正常显示 DeepSeek；
     一切到「火山引擎」（面板变高、出现内部滚动），顶部那格就又空了。
     DOM 层是对的（selectedIndex 有值、value 正常、模型框也对），所以这是**原生控件绘制**
     层面的问题：这个 <select> 在不滚动时能画字，一滚动就不画了（同一份代码在桌面 Chrome 上
     永远正常，抓不到，只能绕开）。
     绕法：不再依赖浏览器给 <select> 画文字 —— 把原生文字设为透明，自己在同一位置叠一层
     <span> 显示当前所选服务商；选值逻辑、下拉列表完全不变（option 单独设了不透明色）。
     这样无论原生控件画不画，框里总有字。 */
  function decorateAIProviderSelect(){
    var sel = document.getElementById('aiProvider');
    if(!sel || !sel.parentNode) return;
    if(sel.__qzDecorated){
      if(sel.__qzSyncLabel) sel.__qzSyncLabel();
      return;
    }
    var wrap = document.createElement('div');
    wrap.className = 'qz-provider-wrap';
    sel.parentNode.insertBefore(wrap, sel);
    wrap.appendChild(sel);

    var label = document.createElement('span');
    label.className = 'qz-provider-label';
    label.setAttribute('aria-hidden', 'true');    // 纯视觉替身：无障碍树里只留原生 select，避免读两遍
    wrap.appendChild(label);

    function sync(){
      var opt = sel.options[sel.selectedIndex];
      label.textContent = opt ? String(opt.textContent || '').replace(/（未识别，请重选）$/, '') : '';
      // 主题把文字色配成和底色一样时（极端皮肤），自绘层也要能读
      try{
        var lcs = window.getComputedStyle(label);
        var bg = window.getComputedStyle(sel).backgroundColor;
        if(lcs && (lcs.color === 'rgba(0, 0, 0, 0)' || lcs.color === bg)) label.style.color = '#1f2937';
      }catch(e){}
    }
    sel.addEventListener('change', sync);
    sel.addEventListener('input', sync);
    try{
      new MutationObserver(sync).observe(sel, { childList: true, subtree: true, attributes: true, attributeFilter: ['selected', 'value'] });
    }catch(e){}
    sel.__qzSyncLabel = sync;
    sel.__qzDecorated = true;
    sync();
  }

  function installAIProviderGuard(){
    if(typeof window.toggleAIPanel === 'function' && !window.toggleAIPanel.__qzVoiceWrapped){
      var orig = window.toggleAIPanel;
      var wrapped = function(){
        var ret = orig.apply(this, arguments);
        ensureAIProviderSelected();
        decorateAIProviderSelect();
        return ret;
      };
      wrapped.__qzVoiceWrapped = true;
      window.toggleAIPanel = wrapped;
    }
    ensureAIProviderSelected();
    decorateAIProviderSelect();
  }

  /* ---------- 12. #aiPanel 增加「语音引擎」设置 ---------- */
  function engineLabel(){
    var p = voiceTtsConfig.provider;
    return p === 'edge' ? 'Edge TTS' : (p === 'volc' ? '火山引擎' : '浏览器自带');
  }
  function syncEngineFields(){
    var panel = document.getElementById('aiPanel');
    if(!panel) return;
    var p = voiceTtsConfig.provider;
    var edgeBox = panel.querySelector('#qzVoiceEdgeBox');
    var volcBox = panel.querySelector('#qzVoiceVolcBox');
    if(edgeBox) edgeBox.style.display = p === 'edge' ? 'block' : 'none';
    if(volcBox) volcBox.style.display = p === 'volc' ? 'block' : 'none';
    var hint = panel.querySelector('#qzVoiceHint');
    if(hint){
      var extra = '';
      if(p === 'edge' && !String(voiceTtsConfig.edgeUrl || '').trim()){
        extra = '（未填地址 → 自动用浏览器语音）';
      }else if(p === 'volc' && !volcAuth()){
        extra = '（未填 API Key → 自动用浏览器语音）';
      }
      hint.innerHTML = '当前引擎：' + escapeHtml(engineLabel()) + extra
        + '<br>第三方引擎失败会自动退回浏览器语音，不会中断播放。';
    }
  }
  function installVoiceSettingsPanel(){
    var panel = document.getElementById('aiPanel');
    if(!panel || panel.querySelector('#qzVoiceProvider')) return true;
    var box = document.createElement('div');
    box.className = 'qz-voice-settings';
    box.innerHTML =
        '<label>语音引擎</label>'
      + '<select id="qzVoiceProvider">'
      +   '<option value="browser">浏览器自带</option>'
      +   '<option value="edge">Edge TTS</option>'
      +   '<option value="volc">火山引擎</option>'
      + '</select>'
      + '<div id="qzVoiceEdgeBox" style="display:none;">'
      +   '<label>Edge TTS 地址（Cloudflare Worker）</label>'
      +   '<input type="url" id="qzVoiceEdgeUrl" placeholder="https://xxx.workers.dev/tts">'
      +   '<label>音色</label>'
      +   '<input type="text" id="qzVoiceEdgeVoice" placeholder="zh-CN-XiaoxiaoNeural">'
      + '</div>'
      + '<div id="qzVoiceVolcBox" style="display:none;">'
      +   '<label>火山 API Key（新版控制台）</label>'
      +   '<input type="password" id="qzVoiceVolcKey" autocomplete="off" placeholder="控制台 → API Key 管理，只填这一个就够了">'
      +   '<label>音色 speaker</label>'
      +   '<input type="text" id="qzVoiceVolcVoice" list="qzVoiceVolcVoiceList" placeholder="' + VOLC_DEFAULT_VOICE + '">'
      +   '<datalist id="qzVoiceVolcVoiceList">'
      +     '<option value="zh_female_vv_uranus_bigtts">2.0 稳重女声（推荐）</option>'
      +     '<option value="zh_female_xiaohe_uranus_bigtts">2.0 亲和女声</option>'
      +     '<option value="zh_male_m191_uranus_bigtts">2.0 沉稳男声</option>'
      +     '<option value="zh_female_wanwanxiaohe_moon_bigtts">1.0 湾湾小何（需选 1.0 版本）</option>'
      +   '</datalist>'
      +   '<label>模型版本</label>'
      +   '<select id="qzVoiceVolcRes">'
      +     '<option value="seed-tts-2.0">豆包语音合成 2.0（seed-tts-2.0）</option>'
      +     '<option value="seed-tts-1.0">豆包语音合成 1.0（seed-tts-1.0）</option>'
      +   '</select>'
      +   '<details class="qz-voice-legacy"><summary>旧版控制台（AppID + Access Token，可选）</summary>'
      +     '<label>AppID</label>'
      +     '<input type="text" id="qzVoiceVolcAppId" placeholder="只有旧版控制台才有">'
      +     '<label>Access Token</label>'
      +     '<input type="password" id="qzVoiceVolcToken" autocomplete="off" placeholder="只有旧版控制台才有">'
      +   '</details>'
      + '</div>'
      + '<label style="display:flex;align-items:center;gap:6px;font-size:12px;">'
      +   '<input type="checkbox" id="qzVoicePrefetch" style="width:auto;margin:0;">'
      +   '简化解析后自动预生成语音稿（多一次 AI 调用，点 🎧 秒播）'
      + '</label>'
      + '<div id="qzVoiceHint" style="font-size:11px;color:#64748b;line-height:1.5;"></div>';
    var saveBtn = panel.querySelector('button.btn-primary') || panel.querySelector('button');
    if(saveBtn) panel.insertBefore(box, saveBtn); else panel.appendChild(box);

    var sel = box.querySelector('#qzVoiceProvider');
    var edgeUrl = box.querySelector('#qzVoiceEdgeUrl');
    var edgeVoice = box.querySelector('#qzVoiceEdgeVoice');
    var volcKey = box.querySelector('#qzVoiceVolcKey');
    var volcVoiceEl = box.querySelector('#qzVoiceVolcVoice');
    var volcRes = box.querySelector('#qzVoiceVolcRes');
    var volcId = box.querySelector('#qzVoiceVolcAppId');
    var volcToken = box.querySelector('#qzVoiceVolcToken');
    var prefetchBox = box.querySelector('#qzVoicePrefetch');
    sel.value = voiceTtsConfig.provider;
    edgeUrl.value = voiceTtsConfig.edgeUrl || '';
    edgeVoice.value = voiceTtsConfig.edgeVoice || '';
    if(volcKey) volcKey.value = voiceTtsConfig.volcApiKey || '';
    if(volcVoiceEl) volcVoiceEl.value = voiceTtsConfig.volcVoice || VOLC_DEFAULT_VOICE;
    if(volcRes) volcRes.value = voiceTtsConfig.volcResourceId || 'seed-tts-2.0';
    volcId.value = voiceTtsConfig.volcAppId || '';
    volcToken.value = voiceTtsConfig.volcToken || '';
    if(prefetchBox) prefetchBox.checked = voiceTtsConfig.prefetch !== false;

    function commit(){
      voiceTtsConfig.provider = (sel.value === 'edge' || sel.value === 'volc') ? sel.value : 'browser';
      voiceTtsConfig.edgeUrl = String(edgeUrl.value || '').trim();
      voiceTtsConfig.edgeVoice = String(edgeVoice.value || '').trim() || 'zh-CN-XiaoxiaoNeural';
      if(volcKey) voiceTtsConfig.volcApiKey = String(volcKey.value || '').trim();
      if(volcVoiceEl) voiceTtsConfig.volcVoice = String(volcVoiceEl.value || '').trim() || VOLC_DEFAULT_VOICE;
      if(volcRes) voiceTtsConfig.volcResourceId = String(volcRes.value || '').trim() || 'seed-tts-2.0';
      voiceTtsConfig.volcAppId = String(volcId.value || '').trim();
      voiceTtsConfig.volcToken = String(volcToken.value || '').trim();
      if(prefetchBox) voiceTtsConfig.prefetch = !!prefetchBox.checked;
      saveVoiceTtsConfig();
      syncEngineFields();
    }
    sel.addEventListener('change', function(){ commit(); voiceStop(); });
    [edgeUrl, edgeVoice, volcKey, volcVoiceEl, volcRes, volcId, volcToken].forEach(function(el){
      if(!el) return;
      el.addEventListener('change', commit);
      el.addEventListener('blur', commit);
    });
    if(prefetchBox) prefetchBox.addEventListener('change', commit);   // 勾选框只在 change 上有意义
    syncEngineFields();
    return true;
  }

  /* ---------- 12b. 预生成：点完「AI 简化解析」顺手把口语稿写好，下次点 🎧 直接秒播 ----------
     这一步只多花一次「改写」的 AI 调用（输入是本机已有的简化解析，不重新解题），
     换来的是最常用的那条路径（先简化解析、再点讲解）从「等十几秒」变成「点开就念」。
     不想多花额度可在语音设置里关掉。 */
  var prefetched = {};
  function prefetchVoiceScript(key){
    if(!key || prefetched[key]) return;
    if(voiceTtsConfig.prefetch === false) return;
    prefetched[key] = true;
    readCache(key).then(function(cached){
      if(cached && cached.t) return null;         // 已有稿子，别再花一次 AI
      return resolveItem(key).then(function(item){
        if(!item) return null;
        return pickExistingAnalysis(key, item).then(function(existing){
          if(!existing.text || existing.origin !== 'simplify') return null;   // 只对「有简化解析」的题预生成
          return rewriteToSpoken(item, existing.text).then(function(script){
            if(!script) return null;
            return writeCache(key, script, 'simplify').then(function(){
              console.log('[VOICE] 已预生成讲解稿：' + key);
            });
          });
        });
      });
    }).catch(function(err){
      console.warn('[VOICE] 预生成讲解稿失败（不影响正常使用）：', err && (err.message || err));
    });
  }

  // 包装 simplifySolution：等它把 type==='simplify' 的历史写完（流式落库，最多等 4 秒）再预生成
  function installSimplifyPrefetch(){
    if(typeof window.simplifySolution !== 'function' || window.simplifySolution.__qzVoiceWrapped) return;
    var orig = window.simplifySolution;
    var wrapped = function(key){
      var ret = orig.apply(this, arguments);
      var tries = 0;
      (function waitHistory(){
        tries++;
        Promise.resolve().then(function(){ return getAIHistory(key); }).then(function(list){
          var has = Array.isArray(list) && list.some(function(m){ return m && m.type === 'simplify' && m.content; });
          if(has){ prefetchVoiceScript(key); return; }
          if(tries < 8) setTimeout(waitHistory, 500);
        }).catch(function(){});
      })();
      return ret;
    };
    wrapped.__qzVoiceWrapped = true;
    window.simplifySolution = wrapped;
  }

  /* ---------- 13. 样式：只补「状态色 / 加载态」，尺寸规则全部沿用 .q-copy-btn ---------- */
  function installStyle(){
    if(document.getElementById('qzVoiceStyle')) return;
    var style = document.createElement('style');
    style.id = 'qzVoiceStyle';
    style.textContent = [
      '.q-title .q-voice-btn.is-playing, .q-title .q-voice-btn.is-paused { color: var(--main); }',
      '.q-title .q-voice-btn.is-loading { opacity: .45; cursor: progress; }',
      // 🎧 + 📋 的不可断行小组：只负责「换行时不被拆开」，间距与 .q-title 的 gap 一致
      '.q-title .q-title-actions { display: inline-flex; align-items: center; gap: 6px; flex: 0 0 auto; }',
      '.qz-voice-settings { display: flex; flex-direction: column; gap: 6px; }',
      '.qz-voice-settings select { width: 100%; box-sizing: border-box; }',
      '.qz-voice-settings #qzVoiceEdgeBox, .qz-voice-settings #qzVoiceVolcBox { display: flex; flex-direction: column; gap: 6px; }',
      // 旧版控制台鉴权折叠区：收起时不占地方，展开时和其它字段同样竖排
      '.qz-voice-settings details.qz-voice-legacy > summary { cursor: pointer; font-size: 11px; color: #64748b; padding: 2px 0; }',
      '.qz-voice-settings details.qz-voice-legacy[open] { display: flex; flex-direction: column; gap: 6px; }',
      // 下拉框文字过长时用省略号，不要整行被裁掉
      '#aiPanel select { text-overflow: ellipsis; }',
      // 「AI 服务商」自绘文字层：原生 <select> 在不滚动时能画字、一滚动就不画（手机端实测），
      // 所以把原生文字设透明，用同位置的 <span> 显示当前值；option 单独给回不透明色，保证下拉列表可读。
      '.qz-provider-wrap { position: relative; display: block; width: 100%; }',
      '.qz-provider-wrap > select { width: 100%; box-sizing: border-box; color: transparent !important; -webkit-text-fill-color: transparent !important; }',
      '.qz-provider-wrap > select > option { color: #1f2937; }',
      '.qz-provider-wrap > .qz-provider-label { position: absolute; left: 12px; right: 30px; top: 0; bottom: 0; display: flex; align-items: center; font-size: 13px; color: var(--deep, #2c6b9e); pointer-events: none; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }',
      // iOS Safari 的坑：fixed + transform 居中 + 面板内部滚动 时，原生 <select> 的文字不重绘（只剩空框）。
      // 面板改为 inset:0 + margin:auto 居中，不再使用 transform（纯视觉等效，行为不变）。
      '#aiPanel { transform: none !important; top: 0; left: 0; right: 0; bottom: 0; margin: auto; height: fit-content; max-height: 86vh; }'
    ].join('\n');
    document.head.appendChild(style);
  }

  /* ---------- 14. 启动 ---------- */
  function boot(){
    installStyle();
    installVoiceSettingsPanel();
    installSimplifyPrefetch();
    installAIProviderGuard();
    scan();
    var content = document.getElementById('content');
    if(content && window.MutationObserver){
      new MutationObserver(function(){ scheduleScan(); }).observe(content, { childList:true, subtree:true });
    }
    // #aiPanel 若被后续代码重建，重装一次设置区（低频兜底）
    setInterval(function(){
      if(!document.getElementById('qzVoiceProvider')) installVoiceSettingsPanel();
      installAIProviderGuard();          // 面板重开后「AI 服务商」也不许空着
    }, 5000);
  }

  // 对外暴露（便于控制台自测 / 其它脚本调用）
  window.qzVoice = {
    speak: function(text){ return speakWithTts(String(text || ''), ++playToken); },
    stop: voiceStop,
    pause: pausePlayback,
    resume: resumePlayback,
    config: voiceTtsConfig,
    saveConfig: saveVoiceTtsConfig,
    clearCache: function(key){
      return cacheDb().then(function(d){
        return new Promise(function(resolve){
          var tx = d.transaction(CACHE_STORE, 'readwrite');
          tx.objectStore(CACHE_STORE).delete(cacheKey(key));
          tx.oncomplete = function(){ resolve(true); };
          tx.onerror = function(){ resolve(false); };
        });
      }).catch(function(){ return false; });
    },
    _placeVoiceButton: placeVoiceButton,
    _installSimplifyPrefetch: installSimplifyPrefetch,
    _prefetch: prefetchVoiceScript,
    _state: voiceState
  };

  if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
