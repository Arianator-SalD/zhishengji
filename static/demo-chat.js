// Keep the supplied V4 prototype's fixtures and topic-aware mock replies configurable.
const demoChatConfig = {
  replyDelayMs: 520,
  initialHTML: document.getElementById('chatBody').innerHTML,
  createReply: (question, expert, previousQA) => generateExpertReply(question, expert, previousQA)
};

(() => {
  const body = document.getElementById('chatBody');
  const input = document.getElementById('chatInput');
  const sessions = new Map();
  let activeExpert = 0;
  body.replaceChildren();

  function sessionFor(i) {
    if (!sessions.has(i)) {
      const seed = document.createElement('div');
      if (i !== 0) {
        seed.innerHTML = demoChatConfig.initialHTML;
        seed.querySelectorAll('img').forEach(img => { img.src = experts[i].img; img.alt = experts[i].name; });
        const greeting = seed.querySelector('.chat-bubble.ai');
        if (greeting) greeting.textContent = greeting.textContent.replace('专家授权的', experts[i].name + '授权的');
        seed.querySelectorAll('.chat-msg').forEach(window.zhijianUI.bindAnswer);
      }
      sessions.set(i, {nodes: [...seed.childNodes], draft: '', lastQA: {q: '', a: ''}});
    }
    return sessions.get(i);
  }
  function select(i) {
    window.zhijianUI.profile(i);
    if (i !== activeExpert) {
      if (activeExpert === 0) window.zhijianVoice?.suspend();
      stopCallDemo(); stopTimer();
      const previous = sessionFor(activeExpert);
      previous.nodes = [...body.childNodes];
      previous.draft = input.value;
      activeExpert = i;
      const next = sessionFor(i);
      body.replaceChildren(...next.nodes);
      input.value = next.draft;
    }
    document.querySelector('.chat-session-bar').style.display = i === 0 ? '' : 'none';
  }
  function append(i, node) {
    sessionFor(i).nodes.push(node);
    if (i === activeExpert) {
      body.append(node);
      body.scrollTop = body.scrollHeight;
    }
  }
  window.zhijianChat = {
    select,
    send() {
      select(selectedExpert);
      if (selectedExpert === 0) return window.zhijianVoice?.send();
      const text = input.value.trim();
      if (!text) return;
      const expert = selectedExpert;
      const session = sessionFor(expert);
      append(expert, appendChatUser(text));
      input.value = '';
      const thinking = appendChatThinking();
      append(expert, thinking);
      const reply = demoChatConfig.createReply(text, expert, session.lastQA);
      session.lastQA = {q: text, a: reply};
      // Capture the expert's avatar and answer before a possible expert switch.
      const row = appendChatAI(reply);
      window.zhijianUI.bindAnswer(row);
      row.remove();
      setTimeout(() => {
        thinking.remove();
        session.nodes = session.nodes.filter(node => node !== thinking);
        append(expert, row);
      }, demoChatConfig.replyDelayMs);
    }
  };
  select(selectedExpert);
})();
