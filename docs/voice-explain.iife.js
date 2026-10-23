/* ============================================================
   [VOICE 2026-10-23] 🎧 讲解 —— AI 口语稿 + 可切换 TTS 播放层
   ------------------------------------------------------------
   设计原则（与 setupIncrementalFeatures / installSortRangePanel 一致）：
     · 全部逻辑收在一个 IIFE 内，不改动任何现有业务函数体；
     · 需要「拦截」的入口（goPage / switchZone / switchFile）一律用包装函数；
     · 已有能力全部复用，不重复实现：
       getOptions / getCorrectLetter / getAIHistory / aiConfig / AI_ENDPOINTS /
       requestAI / getBestChineseVoice / stopSpeaking / filteredQuestions / escapeHtml
   链路：
     点 🎧 讲解 → IndexedDB 缓存 en_voice_explain_<qid>
                → 无缓存：取「已有解析」（简化解析缓存 → item.solution）
                → AI 改写成口语稿（只改表达，不重新解题）→ 写缓存 → speakWithTts()
                → AI 失败 / 未配 Key → 直接播原解析兜底
   播放层：voiceTtsConfig.provider = 'browser'(默认) | 'edge' | 'volc'(预留)
           第三方失败 → console.warn + 自动降级 browser，不弹窗、不卡住
   ============================================================ */
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
  var voiceTtsConfig = {
    provider: 'browser',                       // 'browser' | 'edge' | 'volc'
    edgeUrl: '',                               // Cloudflare Worker 网关地址（POST {text, voice} → audio/*）
    edgeVoice: 'zh-CN-XiaoxiaoNeural',         // Edge TTS 音色
    volcAppId: '',                             // 火山引擎：预留
    volcToken: '',                             // 火山引擎：预留
    volcVoice: 'zh_female_wanwanxiaohe_moon_bigtts'
  };
  var VOICE_CFG_FIELDS = ['edgeUrl', 'edgeVoice', 'volcAppId', 'volcToken', 'volcVoice'];

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
    }catch(e){ console.warn('[VOICE] 读取语音配置失败：', e && (e.message || e)); }
  }
  function saveVoiceTtsConfig(){
    try{ localStorage.setItem(CFG_KEY, JSON.stringify(voiceTtsConfig)); }
    catch(e){ console.warn('[VOICE] 保存语音配置失败：', e && (e.message || e)); }
  }
  loadVoiceTtsConfig();

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
      startSpeak(key, text, voiceState.source);
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

  // 火山引擎 HTTP 合成接口：本期只留契约与占位，不做真实调用（未拿到稳定网关地址，
  // 且需要 appid+token+cluster 三件套签名，直接硬编码会误导使用者）。
  // TODO(volc): 接入 https://openspeech.bytedance.com/api/v1/tts
  //   POST headers: { Authorization: 'Bearer;' + token }
  //   body: { app:{ appid, token, cluster:'volcano_tts' }, user:{uid:'qz'},
  //           audio:{ voice_type: volcVoice, encoding:'mp3' }, request:{ reqid, text, operation:'query' } }
  //   成功时 body.data 为 base64 音频 → 转 Blob 后交给 playObjectUrl()
  function speakVolc(text, token){
    return Promise.reject(new Error('火山引擎 TTS 尚未接入（预留）'));
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
          // ③ AI 口语化改写
          return rewriteToSpoken(item, existing.text).then(function(script){
            if(!alive()) return null;
            writeCache(key, script, existing.origin);
            startSpeak(key, script, 'ai');
          }).catch(function(err){
            if(!alive()) return null;
            console.warn('[VOICE] AI 讲解改写失败，改用原解析播报：', err && (err.message || err));
            var reason = (err && err.message) || '';
            toast(/Key|Key|apiKey|中转/i.test(reason) ? '未配置/不可用的 AI，已用原解析播报' : 'AI 讲解失败，已用原解析播报');
            startSpeak(key, existing.text, 'raw');   // ⑤ 兜底：原解析原文
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
      var extra = p === 'edge' && !String(voiceTtsConfig.edgeUrl || '').trim() ? '（未填地址 → 自动用浏览器语音）' : '';
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
      +   '<label>火山 AppID（预留）</label>'
      +   '<input type="text" id="qzVoiceVolcAppId" placeholder="尚未接入，占位">'
      +   '<label>火山 Access Token（预留）</label>'
      +   '<input type="password" id="qzVoiceVolcToken" placeholder="尚未接入，占位">'
      + '</div>'
      + '<div id="qzVoiceHint" style="font-size:11px;color:#64748b;line-height:1.5;"></div>';
    var saveBtn = panel.querySelector('button.btn-primary') || panel.querySelector('button');
    if(saveBtn) panel.insertBefore(box, saveBtn); else panel.appendChild(box);

    var sel = box.querySelector('#qzVoiceProvider');
    var edgeUrl = box.querySelector('#qzVoiceEdgeUrl');
    var edgeVoice = box.querySelector('#qzVoiceEdgeVoice');
    var volcId = box.querySelector('#qzVoiceVolcAppId');
    var volcToken = box.querySelector('#qzVoiceVolcToken');
    sel.value = voiceTtsConfig.provider;
    edgeUrl.value = voiceTtsConfig.edgeUrl || '';
    edgeVoice.value = voiceTtsConfig.edgeVoice || '';
    volcId.value = voiceTtsConfig.volcAppId || '';
    volcToken.value = voiceTtsConfig.volcToken || '';

    function commit(){
      voiceTtsConfig.provider = (sel.value === 'edge' || sel.value === 'volc') ? sel.value : 'browser';
      voiceTtsConfig.edgeUrl = String(edgeUrl.value || '').trim();
      voiceTtsConfig.edgeVoice = String(edgeVoice.value || '').trim() || 'zh-CN-XiaoxiaoNeural';
      voiceTtsConfig.volcAppId = String(volcId.value || '').trim();
      voiceTtsConfig.volcToken = String(volcToken.value || '').trim();
      saveVoiceTtsConfig();
      syncEngineFields();
    }
    sel.addEventListener('change', function(){ commit(); voiceStop(); });
    [edgeUrl, edgeVoice, volcId, volcToken].forEach(function(el){
      el.addEventListener('change', commit);
      el.addEventListener('blur', commit);
    });
    syncEngineFields();
    return true;
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
      '.qz-voice-settings #qzVoiceEdgeBox, .qz-voice-settings #qzVoiceVolcBox { display: flex; flex-direction: column; gap: 6px; }'
    ].join('\n');
    document.head.appendChild(style);
  }

  /* ---------- 14. 启动 ---------- */
  function boot(){
    installStyle();
    installVoiceSettingsPanel();
    scan();
    var content = document.getElementById('content');
    if(content && window.MutationObserver){
      new MutationObserver(function(){ scheduleScan(); }).observe(content, { childList:true, subtree:true });
    }
    // #aiPanel 若被后续代码重建，重装一次设置区（低频兜底）
    setInterval(function(){
      if(!document.getElementById('qzVoiceProvider')) installVoiceSettingsPanel();
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
    _state: voiceState
  };

  if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
