(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  let socket, connecting, config, turn = null, activeSegment = null, playbackTime = 0;
  let audioContext, sources = new Set(), mic, micNode, micSource, silentGain;
  let recording = false, micEpoch = 0, frames = 0;
  let mode = 'text', liveReply, voiceReply, busy = false, generationDone = false;
  let ignoreTurn = false, ignoredTurns = new Set(), currentReplyText = '';
  let requestId = null, failed = false;
  let useDemoProfile = true;
  const send = obj => { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(obj)); };
  function status(text, error = false) {
    $('voiceStatus').textContent = text; $('voiceStatus').classList.toggle('voice-error', error);
    $('callStatus').textContent = text;
  }
  function bubble(container, text, who) {
    return window.zhijianUI.bubble(container, text, who);
  }
  function state(value) {
    $('callModal').dataset.state = value;
    $('muteBtn').disabled = !busy && !sources.size;
    window.zhijianUI.state(value, {recording, busy, hasAudio: sources.size > 0, mode});
  }
  function stopPlayback() {
    for (const s of sources) { s.onended = null; try { s.stop(); } catch {} }
    sources.clear(); playbackTime = 0; activeSegment = null;
  }
  async function context() {
    audioContext ||= new AudioContext();
    if (audioContext.state === 'suspended') await audioContext.resume();
    return audioContext;
  }
  function endMic(notify = true) {
    ++micEpoch; const wasRecording = recording; recording = false;
    if (micNode) { micNode.port.onmessage = null; micNode.disconnect(); micNode = null; }
    micSource?.disconnect(); micSource = null; silentGain?.disconnect(); silentGain = null;
    mic?.getTracks().forEach(t => t.stop()); mic = null;
    if (wasRecording && notify) { send({type:'audio.end'}); busy = true; status('正在识别并思考…'); }
    state(wasRecording && notify ? 'thinking' : 'idle');
  }
  function interrupt() {
    const wasActive = busy || sources.size > 0;
    endMic(false); if (turn) ignoredTurns.add(turn);
    ignoreTurn = true; requestId = null; send({type:'interrupt'}); stopPlayback(); busy = false;
    if (currentReplyText && wasActive) { liveReply?.append('\n（已打断）'); voiceReply?.append('\n（已打断）'); }
    turn = null; liveReply = voiceReply = null; currentReplyText = ''; state('idle'); status('已停止，可以继续提问');
  }
  async function connect() {
    if (socket?.readyState === WebSocket.OPEN) return;
    if (connecting) return connecting;
    connecting = new Promise((resolve, reject) => {
      const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws/voice`);
      socket = ws; ws.binaryType = 'arraybuffer';
      const timeout = setTimeout(() => { ws.close(); reject(new Error('连接超时，请确认后端已启动')); }, 8000);
      ws.onopen = () => {
        if (ws === socket) send({type:'session.start',use_demo_profile:useDemoProfile});
      };
      ws.onmessage = e => {
        if (ws !== socket) return;
        if (typeof e.data !== 'string') { playPCM(e.data); return; }
        let m; try { m = JSON.parse(e.data); } catch { return; }
        if (m.type === 'session.ready') { clearTimeout(timeout); resolve(); }
        handle(m);
      };
      ws.onerror = () => { clearTimeout(timeout); reject(new Error('无法连接对话后端')); };
      ws.onclose = () => {
        clearTimeout(timeout); reject(new Error('对话连接已断开'));
        if (socket === ws) { socket = null; endMic(false); stopPlayback(); busy = false; state('idle'); status('连接已断开，重新提问可连接', true); }
      };
    }).finally(() => { connecting = null; });
    return connecting;
  }
  function acceptTurn(m) {
    if (ignoredTurns.has(m.turn_id) || ignoreTurn) return false;
    if (turn !== m.turn_id) { turn = m.turn_id; liveReply = voiceReply = null; currentReplyText = ''; }
    return true;
  }
  function finished() {
    if (!failed && generationDone && sources.size === 0) { busy = false; state('idle'); status('回答完成，可以继续追问'); }
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
  function handle(m) {
    // Late Sally events must not appear in another expert's demo conversation.
    if (selectedExpert !== 0) return;
    const scoped = ['transcript.partial','transcript.final','reply.delta','audio.start','audio.end','turn.end'];
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
    if (m.type === 'audio.end' && activeSegment?.segment_id === m.segment_id) { activeSegment.ended = true; acknowledge(activeSegment); activeSegment = null; }
    if (m.type === 'turn.end' && !ignoreTurn && !ignoredTurns.has(m.turn_id)) { generationDone = true; finished(); }
    if (m.type === 'error') { failed = true; endMic(false); stopPlayback(); busy = false; const message = m.message + (m.diagnostic ? `（${m.diagnostic}）` : ''); status(message, true); state('idle'); bubble(mode === 'voice' ? 'callTranscript' : 'chatBody', message, 'ai'); }
  }
  async function beginMic() {
    if (recording) { endMic(); return; }
    if (!config?.capabilities?.asr || !config?.capabilities?.llm || !config?.capabilities?.tts) { status('语音咨询需要配置 DeepSeek、语音识别和语音合成 API', true); return; }
    interrupt(); ignoreTurn = false; generationDone = false; failed = false;
    const epoch = ++micEpoch;
    try {
      const ctx = await context(); if (epoch !== micEpoch) return;
      await connect(); if (epoch !== micEpoch) return;
      const stream = await navigator.mediaDevices.getUserMedia({audio:{channelCount:1,echoCancellation:true,noiseSuppression:true}});
      if (epoch !== micEpoch) { stream.getTracks().forEach(t => t.stop()); return; }
      mic = stream; await ctx.audioWorklet.addModule('/static/audio-worklet.js');
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
    if (!config?.capabilities?.llm) { status('管理员尚未配置 DeepSeek API Key', true); toast('暂时无法连接咨询服务，请稍后重试'); return; }
    interrupt(); const epoch = micEpoch;
    try {
      if (speak) await context(); if (epoch !== micEpoch) return;
      await connect(); if (epoch !== micEpoch) return;
      ignoreTurn = false; generationDone = false; failed = false; turn = null; currentReplyText = ''; liveReply = voiceReply = null;
      bubble('chatBody',text,'me'); bubble('callTranscript',text,'me'); busy = true; state('thinking'); status('正在思考…');
      requestId = crypto.randomUUID(); send({type:'input.text',text,speak,request_id:requestId});
    } catch (e) { if (epoch === micEpoch) status(e.message,true); }
  }
  function reset() {
    interrupt(); send({type:'session.reset'}); socket?.close(); socket = null; connecting = null;
    $('chatBody').textContent = ''; $('callTranscript').textContent = ''; window.zhijianUI.clear();
    window.zhijianUI.memory(useDemoProfile, config?.profile);
    status(useDemoProfile ? '新会话：已带入演示档案，可以直接提问' : '新会话：不带入档案，只使用接下来的对话');
  }
  window.zhijianVoice = {
    suspend() { interrupt(); },
    setDemoProfile(enabled) {
      if (selectedExpert !== 0 || typeof enabled !== 'boolean' || enabled === useDemoProfile) return;
      useDemoProfile = enabled;
      reset();
    },
    beginMic,
    startCall() { mode = 'voice'; state('idle'); status('点击说话，说完后手动发送'); },
    open(id) { mode = id === 'callModal' ? 'voice' : 'text'; },
    close(id) { if (id === 'callModal') interrupt(); },
    send() { const text = $('chatInput').value.trim(); $('chatInput').value = ''; return submit(text); }
  };
  $('resetSession').onclick = reset;
  $('voiceTextSend').onclick = () => { const text = $('voiceTextInput').value; $('voiceTextInput').value = ''; submit(text, !!config?.capabilities?.tts); };
  $('voiceTextInput').onkeydown = e => { if (e.key === 'Enter' && !e.isComposing) $('voiceTextSend').click(); };
  window.addEventListener('pagehide',() => { endMic(false); stopPlayback(); socket?.close(); });
  fetch('/api/config').then(r => { if (!r.ok) throw new Error('后端尚未启动'); return r.json(); }).then(c => {
    config = c; const ready = c.capabilities;
    window.zhijianUI.memory(useDemoProfile, c.profile);
    status(`DeepSeek ${ready.llm?'已配置':'待配置'} · 语音识别 ${ready.asr?'已配置':'待配置'} · 语音合成 ${ready.tts?'已配置':'待配置'}`);
    questionSets[0] = c.qa.map(q => q.question); renderSuggestedQuestions(selectedExpert);

  }).catch(e => status(e.message + '。请通过 FastAPI 提供的网址打开页面。',true));
  state('idle');
})();
