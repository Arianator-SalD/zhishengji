(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  let socket, connecting, config, turn = null, activeSegment = null, playbackTime = 0;
  let audioContext, sources = new Set(), mic, micNode, micSource, silentGain;
  let filePlayback = null, fileSegments = new Set();
  let recording = false, micEpoch = 0, frames = 0, cancelWorklet;
  let mode = 'text', liveReply, voiceReply, busy = false, generationDone = false;
  let ignoreTurn = false, ignoredTurns = new Set(), currentReplyText = '';
  let requestId = null, failed = false;
  let activeId = experts[selectedExpert]?.voiceId || null, sessionEpoch = 0, configLoading;
  const profileModes = new Map();
  let useDemoProfile = activeId === 'sally';
  const isActive = () => Boolean(activeId) && experts[selectedExpert]?.voiceId === activeId;
  const send = obj => { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(obj)); };
  function status(text, error = false) {
    $('voiceStatus').textContent = text; $('voiceStatus').classList.toggle('voice-error', error);
    $('voiceStatus').hidden = !error;
    $('callStatus').textContent = text;
  }
  function bubble(container, text, who) {
    return window.zhijianUI.bubble(container, text, who);
  }
  function state(value) {
    $('callModal').dataset.state = value;
    $('muteBtn').disabled = !busy && !sources.size && !filePlayback;
    window.zhijianUI.state(value, {recording, busy, hasAudio: sources.size > 0 || Boolean(filePlayback), mode});
  }
  function stopPlayback() {
    const file = filePlayback; filePlayback = null; fileSegments.clear();
    if (file) {
      clearTimeout(file.timer);
      if (file.audio) {
        file.audio.onended = file.audio.onerror = file.audio.onplaying = file.audio.ontimeupdate = null;
        file.audio.pause(); file.audio.removeAttribute('src'); file.audio.load();
      }
    }
    for (const s of sources) { s.onended = null; try { s.stop(); } catch {} }
    sources.clear(); playbackTime = 0; activeSegment = null;
  }
  async function context() {
    audioContext ||= new AudioContext();
    if (audioContext.state === 'suspended') await audioContext.resume();
    return audioContext;
  }
  function endMic(notify = true) {
    ++micEpoch; cancelWorklet?.();
    const wasRecording = recording; recording = false;
    if (micNode) { micNode.port.onmessage = null; micNode.disconnect(); micNode = null; }
    micSource?.disconnect(); micSource = null; silentGain?.disconnect(); silentGain = null;
    mic?.getTracks().forEach(t => t.stop()); mic = null;
    if (wasRecording && notify) { send({type:'audio.end'}); busy = true; status('正在识别并思考…'); }
    state(wasRecording && notify ? 'thinking' : 'idle');
  }
  function interrupt() {
    const wasActive = busy || sources.size > 0 || Boolean(filePlayback);
    endMic(false); if (turn) ignoredTurns.add(turn);
    ignoreTurn = true; requestId = null; send({type:'interrupt'}); stopPlayback(); busy = false;
    if (currentReplyText && wasActive) { liveReply?.append('\n（已打断）'); voiceReply?.append('\n（已打断）'); }
    turn = null; liveReply = voiceReply = null; currentReplyText = ''; state('idle'); status('已停止，可以继续提问');
  }
  async function loadConfig() {
    if (!isActive()) return null;
    if (config) return config;
    if (configLoading) return configLoading;
    const id = activeId, epoch = sessionEpoch;
    const pending = fetch(`/api/config?expert_id=${encodeURIComponent(id)}`).then(r => {
      if (!r.ok) throw new Error('暂时无法读取咨询配置');
      return r.json();
    }).then(c => {
      if (epoch !== sessionEpoch || id !== activeId) return null;
      if (c.expert_id && c.expert_id !== id) throw new Error('专家配置不匹配，请重新选择');
      config = c;
      if (!profileModes.has(id)) useDemoProfile = c.default_use_demo_profile ?? (id === 'sally');
      window.zhijianUI.memory(useDemoProfile, c.profile, id);
      status('可以开始咨询');
      refreshQuestions();
      return c;
    }).finally(() => { if (configLoading === pending) configLoading = null; });
    configLoading = pending;
    return pending;
  }
  function refreshQuestions() {
    if (!config || !isActive()) return;
    const i = experts.findIndex(e => e.voiceId === activeId);
    const starters = useDemoProfile && config.profile?.starter_questions;
    questionSets[i] = Array.isArray(starters) && starters.length ? starters : config.qa.map(q => q.question);
    renderSuggestedQuestions(i);
  }
  async function connect() {
    if (!isActive()) return;
    if (connecting) return connecting;
    if (socket?.readyState === WebSocket.OPEN) return;
    const id = activeId, epoch = sessionEpoch;
    const pending = new Promise((resolve, reject) => {
      const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws/voice?expert_id=${encodeURIComponent(id)}`);
      socket = ws; ws.binaryType = 'arraybuffer';
      const current = () => ws === socket && epoch === sessionEpoch && id === activeId && isActive();
      const timeout = setTimeout(() => { ws.close(); reject(new Error('连接超时，请确认后端已启动')); }, 8000);
      ws.onopen = () => {
        if (current()) send({type:'session.start',use_demo_profile:useDemoProfile});
      };
      ws.onmessage = e => {
        if (!current()) return;
        if (typeof e.data !== 'string') { playPCM(e.data); return; }
        let m; try { m = JSON.parse(e.data); } catch { return; }
        if (m.type === 'session.ready') {
          if (m.expert_id && m.expert_id !== id) { ws.close(); return; }
          clearTimeout(timeout); resolve();
        }
        handle(m);
      };
      ws.onerror = () => { clearTimeout(timeout); reject(new Error('无法连接对话后端')); };
      ws.onclose = () => {
        clearTimeout(timeout); reject(new Error('对话连接已断开'));
        if (current()) { socket = null; endMic(false); stopPlayback(); busy = false; state('idle'); status('连接已断开，重新提问可连接', true); }
      };
    }).finally(() => { if (connecting === pending) connecting = null; });
    connecting = pending;
    return pending;
  }
  function discardSession() {
    ++sessionEpoch;
    endMic(false); stopPlayback();
    const oldSocket = socket; socket = null; connecting = null; configLoading = null;
    oldSocket?.close();
    busy = false; failed = false; generationDone = false; ignoreTurn = true;
    requestId = turn = null; ignoredTurns.clear(); liveReply = voiceReply = null; currentReplyText = '';
    $('chatBody').textContent = ''; $('callTranscript').textContent = '';
    $('chatInput').value = ''; $('voiceTextInput').value = '';
    window.zhijianUI.clear(); state('idle');
  }
  function select(i) {
    const id = experts[i]?.voiceId || null;
    if (id === activeId) return;
    discardSession(); activeId = id; config = null;
    useDemoProfile = profileModes.get(id) ?? (id === 'sally');
    window.zhijianUI.memory(useDemoProfile, null, id);
    if (!id) return;
    state('idle'); status('正在读取咨询配置…');
    const epoch = sessionEpoch;
    loadConfig().catch(e => { if (epoch === sessionEpoch) status(e.message, true); });
  }
  function acceptTurn(m) {
    if (ignoredTurns.has(m.turn_id) || ignoreTurn) return false;
    if (turn !== m.turn_id) { turn = m.turn_id; liveReply = voiceReply = null; currentReplyText = ''; }
    return true;
  }
  function finished() {
    if (generationDone && sources.size === 0 && !filePlayback) {
      busy = false; state('idle');
      if (!failed) status('回答完成，可以继续追问');
    }
  }
  function acknowledge(segment) {
    if (segment && segment.ended && segment.remaining === 0 && !segment.acked && !ignoredTurns.has(segment.turn_id)) {
      segment.acked = true; send({type:'playback.ack',turn_id:segment.turn_id,segment_id:segment.segment_id});
    }
    finished();
  }
  function playPCM(buffer) {
    const segment = activeSegment;
    if (!segment || ignoreTurn || ignoredTurns.has(segment.turn_id) || !audioContext) return;
    // Preserve a trailing byte if the transport splits a PCM sample.
    let bytes = new Uint8Array(buffer);
    if (segment.tail !== undefined) { const joined = new Uint8Array(bytes.length + 1); joined[0] = segment.tail; joined.set(bytes, 1); bytes = joined; segment.tail = undefined; }
    if (bytes.length % 2) { segment.tail = bytes[bytes.length - 1]; bytes = bytes.slice(0, -1); }
    if (!bytes.length) return;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const audio = audioContext.createBuffer(1, bytes.length / 2, segment.sample_rate);
    const samples = audio.getChannelData(0);
    for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(i * 2, true) / 32768;
    const source = audioContext.createBufferSource(); source.buffer = audio; source.connect(audioContext.destination);
    sources.add(source); segment.remaining++;
    source.onended = () => { sources.delete(source); segment.remaining--; acknowledge(segment); };
    playbackTime = Math.max(audioContext.currentTime + 0.04, playbackTime);
    source.start(playbackTime); playbackTime += audio.duration; state('speaking'); status('正在回答…');
  }
  function playFile(message) {
    const key = `${message.turn_id}:${message.segment_id}`;
    if (failed || fileSegments.has(key)) return;
    fileSegments.add(key);
    const segment = {...message, remaining:1, ended:false, acked:false};
    const file = {audio:null, timer:null}, epoch = sessionEpoch;
    filePlayback = file;
    const current = () => filePlayback === file && epoch === sessionEpoch &&
      requestId === message.request_id && turn === message.turn_id && !ignoreTurn && !ignoredTurns.has(turn);
    const fail = () => {
      if (!current()) return;
      // Audio failure must not cancel the remaining fake text stream.
      failed = true; stopPlayback(); busy = !generationDone;
      state(busy ? 'thinking' : 'idle');
      status('固定语音未能播放，请查看文字回答，或重新提问播放。', true);
    };
    const refreshDeadline = () => { clearTimeout(file.timer); file.timer = setTimeout(fail, 20000); };
    try {
      if (!/^\/static\/fixed-audio\/[a-z0-9-]+\.wav$/.test(message.url) ||
          !message.url.startsWith(`/static/fixed-audio/${activeId}-`)) throw new Error('Invalid fixed audio');
      // A complete, versioned file uses the browser media pipeline. It does not
      // pass through the per-chunk PCM AudioBufferSource scheduling above.
      const audio = new Audio(message.url); file.audio = audio; audio.preload = 'auto';
      audio.onerror = fail;
      audio.onplaying = () => {
        if (!current()) return;
        refreshDeadline(); state('speaking'); status('正在回答…');
      };
      audio.ontimeupdate = () => { if (current()) refreshDeadline(); };
      audio.onended = () => {
        if (!current()) return;
        clearTimeout(file.timer); filePlayback = null;
        audio.onended = audio.onerror = audio.onplaying = audio.ontimeupdate = null;
        segment.ended = true; segment.remaining = 0; acknowledge(segment);
      };
      refreshDeadline(); state('thinking'); status('正在加载语音…');
      Promise.resolve(audio.play()).catch(fail);
    } catch { fail(); }
  }
  function handle(m) {
    if (!isActive()) return;
    const scoped = ['transcript.partial','transcript.final','reply.delta','audio.start','audio.end','audio.file','turn.end'];
    if ((scoped.includes(m.type) || m.request_id != null) && m.request_id !== requestId) return;
    if (scoped.includes(m.type) && !requestId) return;
    if (m.type === 'transcript.partial') window.zhijianUI.partial(m.text);
    if (m.type === 'transcript.final') {
      window.zhijianUI.finishTranscript(m.text); if (m.text) bubble('chatBody',m.text,'me');
    }
    if (m.type === 'reply.delta' && acceptTurn(m)) {
      liveReply ||= bubble('chatBody','','ai'); voiceReply ||= bubble('callTranscript','','ai');
      currentReplyText += m.text; liveReply.textContent = voiceReply.textContent = currentReplyText;
      for (const id of ['chatBody','callTranscript']) $(id).scrollTop = $(id).scrollHeight;
    }
    if (m.type === 'audio.start' && acceptTurn(m)) activeSegment = {...m,remaining:0,ended:false,acked:false};
    if (m.type === 'audio.file' && acceptTurn(m)) playFile(m);
    if (m.type === 'audio.end' && activeSegment?.segment_id === m.segment_id) { activeSegment.ended = true; acknowledge(activeSegment); activeSegment = null; }
    if (m.type === 'turn.end' && !ignoreTurn && !ignoredTurns.has(m.turn_id)) { generationDone = true; finished(); }
    if (m.type === 'error') { failed = true; endMic(false); stopPlayback(); busy = false; const message = m.message + (m.diagnostic ? `（${m.diagnostic}）` : ''); status(message, true); state('idle'); bubble(mode === 'voice' ? 'callTranscript' : 'chatBody', message, 'ai'); }
  }
  function prepareWorklet(ctx) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = error => {
        if (settled) return;
        settled = true; clearTimeout(timeout);
        if (cancelWorklet === cancel) cancelWorklet = null;
        if (error) reject(error); else resolve();
      };
      const cancel = () => finish(new Error('录音准备已取消'));
      const timeout = setTimeout(() => finish(new Error('录音初始化超时，请重试或改用文字提问')), 8000);
      cancelWorklet = cancel;
      try { Promise.resolve(ctx.audioWorklet.addModule('/static/audio-worklet.js')).then(() => finish(), finish); }
      catch (error) { finish(error); }
    });
  }
  async function beginMic() {
    if (recording) { endMic(); return; }
    const openingEpoch = sessionEpoch, openingMicEpoch = micEpoch;
    try { await loadConfig(); } catch (e) { if (openingEpoch === sessionEpoch) status(e.message, true); return; }
    if (openingEpoch !== sessionEpoch || openingMicEpoch !== micEpoch || !isActive()) return;
    if (!config?.capabilities?.asr || !config?.capabilities?.llm || !(config?.capabilities?.tts || config?.fixed_audio)) { status('语音咨询需要配置对话模型、语音识别和可用音频', true); return; }
    interrupt(); ignoreTurn = false; generationDone = false; failed = false;
    status('正在准备麦克风…');
    const epoch = ++micEpoch;
    try {
      const ctx = await context(); if (epoch !== micEpoch) return;
      await connect(); if (epoch !== micEpoch) return;
      const stream = await navigator.mediaDevices.getUserMedia({audio:{channelCount:1,echoCancellation:true,noiseSuppression:true}});
      if (epoch !== micEpoch) { stream.getTracks().forEach(t => t.stop()); return; }
      mic = stream; await prepareWorklet(ctx);
      if (epoch !== micEpoch) return;
      micSource = ctx.createMediaStreamSource(stream); micNode = new AudioWorkletNode(ctx,'pcm-recorder');
      silentGain = ctx.createGain(); silentGain.gain.value = 0;
      micSource.connect(micNode); micNode.connect(silentGain); silentGain.connect(ctx.destination);
      recording = true; frames = 0;
      requestId = crypto.randomUUID(); send({type:'audio.start',request_id:requestId});
      micNode.port.onmessage = ({data}) => {
        if (!recording) return;
        if (socket?.readyState !== WebSocket.OPEN || socket.bufferedAmount > 640000) { endMic(false); status('网络发送堵塞，请重新开始',true); return; }
        socket.send(data.buffer); frames++;
        if (frames >= 600) endMic();
      };
      status('正在听，说完后点击「说完了，发送」（最长 60 秒）'); state('listening');
    } catch (e) { if (epoch !== micEpoch) return; endMic(false); status(e.name === 'NotAllowedError' ? '麦克风权限未开启，可改用文字提问' : e.message, true); }
  }
  async function submit(text, speak = false) {
    if (!text.trim()) return;
    const openingEpoch = sessionEpoch, openingMicEpoch = micEpoch;
    try { await loadConfig(); } catch (e) { if (openingEpoch === sessionEpoch) status(e.message, true); return; }
    if (openingEpoch !== sessionEpoch || openingMicEpoch !== micEpoch || !isActive()) return;
    if (!config?.capabilities?.llm) { status('暂时无法连接咨询服务，请稍后重试', true); return; }
    speak = speak && Boolean(config.capabilities.tts || config.fixed_audio);
    interrupt(); const epoch = micEpoch;
    try {
      if (speak) await context(); if (epoch !== micEpoch) return;
      await connect(); if (epoch !== micEpoch) return;
      ignoreTurn = false; generationDone = false; failed = false; turn = null; currentReplyText = ''; liveReply = voiceReply = null;
      bubble('chatBody',text,'me'); bubble('callTranscript',text,'me'); busy = true; state('thinking'); status('正在思考…');
      requestId = crypto.randomUUID(); send({type:'input.text',text,speak,request_id:requestId});
      return true;
    } catch (e) { if (epoch === micEpoch) status(e.message,true); }
  }
  function reset() {
    if (!isActive()) return;
    send({type:'session.reset'}); discardSession();
    window.zhijianUI.memory(useDemoProfile, config?.profile, activeId);
    refreshQuestions();
    status('可以开始新的对话');
  }
  window.zhijianVoice = {
    select,
    reset,
    suspend() { interrupt(); },
    setDemoProfile(enabled) {
      if (!isActive() || typeof enabled !== 'boolean' || enabled === useDemoProfile) return;
      useDemoProfile = enabled; profileModes.set(activeId, enabled);
      reset();
    },
    beginMic,
    startCall() { select(selectedExpert); mode = 'voice'; state('idle'); status('点击说话，说完后手动发送'); },
    open(id) { select(selectedExpert); mode = id === 'callModal' ? 'voice' : 'text'; },
    close(id) { if (id === 'callModal') interrupt(); },
    async send() {
      const text = $('chatInput').value.trim();
      if (await submit(text)) { if ($('chatInput').value.trim() === text) $('chatInput').value = ''; }
    }
  };
  $('voiceTextSend').onclick = async () => {
    const text = $('voiceTextInput').value;
    if (await submit(text, true)) { if ($('voiceTextInput').value === text) $('voiceTextInput').value = ''; }
  };
  $('voiceTextInput').onkeydown = e => { if (e.key === 'Enter' && !e.isComposing) $('voiceTextSend').click(); };
  window.addEventListener('pagehide',() => { endMic(false); stopPlayback(); socket?.close(); });
  if (activeId) {
    window.zhijianUI.memory(useDemoProfile, null, activeId);
    const epoch = sessionEpoch;
    loadConfig().catch(e => { if (epoch === sessionEpoch) status(e.message, true); });
  }
  state('idle');
})();
