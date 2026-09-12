// Local discovery only: opening a question never sends it to a model automatically.
(() => {
  const normalize = text => String(text || '').normalize('NFKC').toLowerCase()
    .replace(/人工智能/g, 'ai').replace(/转行/g, '转型').replace(/\s+/g, '')
    .replace(/[，。？！、,.?!「」“”"']/g, '');
  const keywords = ['ai', '产品', '金融', '实习', '简历', '面试', '战略', '运营', '数据分析',
    '商业分析', '营销', '技术', '转型', '职业', 'offer', '校招', '应届生', 'agent'];
  function find(query, experts, questionSets) {
    const q = normalize(query).slice(0, 100);
    const terms = [...new Set([...keywords.filter(k => q.includes(k)), ...(String(query).toLowerCase().match(/[a-z0-9]+/g) || [])])];
    const score = (primary, secondary = '') => {
      if (!q) return 1;
      const a = normalize(primary), b = normalize(secondary);
      return (a === q ? 1000 : a.includes(q) ? 300 : b.includes(q) ? 100 : 0)
        + terms.reduce((sum, term) => sum + (a.includes(term) ? 20 : b.includes(term) ? 5 : 0), 0);
    };
    const people = [], questions = [];
    experts.forEach((expert, expertIndex) => {
      const context = [expert.group, expert.role, expert.full, ...(expert.tags || []), ...(expert.categories || []), expert.intro].join(' ');
      const rank = score(expert.name, context);
      if (rank > 0) people.push({kind:'expert', expertIndex, title:expert.name, subtitle:expert.full || expert.role, score:rank});
      const seen = new Set();
      (questionSets[expertIndex] || []).forEach(question => {
        if (seen.has(question)) return;
        seen.add(question);
        const rank = score(question, expert.name + ' ' + (expert.tags || []).join(' '));
        if (rank > 0) questions.push({kind:'question', expertIndex, title:question, subtitle:expert.name + ' · 打开咨询', question, score:rank});
      });
    });
    const ranked = items => items.sort((a,b) => b.score - a.score).slice(0,4);
    return [...ranked(people), ...ranked(questions)];
  }
  if (typeof module !== 'undefined' && module.exports) { module.exports = {find}; return; }

  const input = document.getElementById('globalSearch');
  if (!input) return;
  const container = input.closest('.search');
  const clear = document.getElementById('clearGlobalSearch');
  const panel = document.getElementById('globalSearchPanel');
  const list = document.getElementById('globalSearchResults');
  const caption = document.getElementById('globalSearchCaption');
  let results = [], active = -1, composing = false;
  function close() {
    panel.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
    active = -1;
  }
  function choose(index) {
    const result = results[index];
    if (!result) return;
    close();
    openExpertDetail(result.expertIndex);
    if (result.kind === 'question') {
      openModal('chatModal');
      const chat = document.getElementById('chatInput');
      chat.value = result.question;
      chat.focus();
    } else input.blur();
  }
  function highlight(index) {
    active = index;
    [...list.querySelectorAll('[role="option"]')].forEach((option,i) => {
      option.classList.toggle('is-active', i === active);
      option.setAttribute('aria-selected', String(i === active));
    });
    const option = list.querySelectorAll('[role="option"]')[active];
    if (option) {
      input.setAttribute('aria-activedescendant', option.id);
      option.scrollIntoView({block:'nearest'});
    }
  }
  function render() {
    results = find(input.value, experts, questionSets);
    active = -1;
    input.removeAttribute('aria-activedescendant');
    clear.hidden = !input.value;
    list.replaceChildren();
    caption.textContent = input.value.trim() ? `找到 ${results.length} 条相关结果` : '试试：AI 产品、简历、金融转行';
    if (!results.length) {
      const empty = document.createElement('p');
      empty.className = 'search-empty';
      empty.textContent = '没有找到相关专家或问题，换个关键词试试。';
      list.append(empty);
    }
    results.forEach((result,index) => {
      const row = document.createElement('button');
      row.type = 'button'; row.className = 'search-result'; row.id = `search-option-${index}`;
      row.tabIndex = -1; row.setAttribute('role','option'); row.setAttribute('aria-selected','false');
      const badge = document.createElement('span'); badge.className = 'search-kind';
      badge.textContent = result.kind === 'expert' ? '专家' : '问题';
      const text = document.createElement('span'); text.className = 'search-result-text';
      const title = document.createElement('strong'); title.textContent = result.title;
      const sub = document.createElement('small'); sub.textContent = result.subtitle;
      text.append(title,sub); row.append(badge,text);
      row.onmousedown = e => e.preventDefault();
      row.onclick = () => choose(index);
      list.append(row);
    });
    panel.hidden = false; input.setAttribute('aria-expanded','true');
  }
  input.addEventListener('focus',render);
  input.addEventListener('input',() => { clear.hidden = !input.value; if (!composing) render(); });
  input.addEventListener('compositionstart',() => { composing = true; });
  input.addEventListener('compositionend',() => { composing = false; render(); });
  input.addEventListener('keydown',e => {
    if (composing || e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Escape') { close(); e.preventDefault(); return; }
    if (!['ArrowDown','ArrowUp','Enter'].includes(e.key)) return;
    e.preventDefault();
    if (panel.hidden) render();
    if (!results.length) return;
    if (e.key === 'Enter') choose(active < 0 ? 0 : active);
    else highlight(active < 0 ? (e.key === 'ArrowDown' ? 0 : results.length - 1)
      : (active + (e.key === 'ArrowDown' ? 1 : -1) + results.length) % results.length);
  });
  clear.onmousedown = e => e.preventDefault();
  clear.onclick = () => { input.value = ''; input.focus(); render(); };
  document.addEventListener('pointerdown',e => { if (!container.contains(e.target)) close(); });
  container.addEventListener('focusout',e => { if (!container.contains(e.relatedTarget)) close(); });
})();
