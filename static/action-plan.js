(() => {
  const plan = document.getElementById('myActionPlan');
  if (!plan) return;
  const storageKey = 'zhishengji.action-plan.v1';
  const tasks = [...plan.querySelectorAll('[data-plan-task]')].map(row => ({
    id: row.dataset.planTask,
    due: row.dataset.planDue,
    row,
    input: row.querySelector('input[type="checkbox"]'),
    badge: row.querySelector('em'),
  }));
  const previews = [...document.querySelectorAll('[data-plan-preview]')].map(row => ({
    row,
    task: tasks.find(task => task.id === row.dataset.planPreview),
    title: row.querySelector('strong').textContent.replace(/^[✓○]\s*/, ''),
    pending: row.querySelector('.status').textContent === '已完成' ? '待完成' : row.querySelector('.status').textContent,
  }));

  try {
    const saved = JSON.parse(localStorage.getItem(storageKey));
    if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
      tasks.forEach(task => {
        if (typeof saved[task.id] === 'boolean') task.input.checked = saved[task.id];
      });
    }
  } catch {
    // Unavailable storage or invalid saved data must not disable the checklist.
  }

  function render() {
    const total = tasks.length;
    const completed = tasks.filter(task => task.input.checked).length;
    const percent = total ? completed / total * 100 : 0;
    const count = `${completed}/${total}`;
    const ring = plan.querySelector('.plan-ring');
    ring.querySelector('b').textContent = count;
    ring.style.setProperty('--plan-progress', `${percent}%`);
    ring.setAttribute('role', 'progressbar');
    ring.setAttribute('aria-label', '本周行动完成进度');
    ring.setAttribute('aria-valuemin', '0');
    ring.setAttribute('aria-valuemax', String(total));
    ring.setAttribute('aria-valuenow', String(completed));
    plan.querySelector('.plan-meta strong').textContent = `${total - completed} 项`;
    plan.querySelector('.plan-summary .progress span').style.width = `${percent}%`;
    document.querySelectorAll('[data-plan-count]').forEach(node => { node.textContent = count; });
    document.querySelectorAll('[data-plan-caption]').forEach(node => { node.textContent = `完成 ${completed} 个关键步骤`; });
    document.querySelectorAll('.goalcard .progress span').forEach(node => { node.style.width = `${percent}%`; });

    tasks.forEach(task => {
      task.row.classList.toggle('checked', task.input.checked);
      task.badge.textContent = task.input.checked ? '已完成' : task.due;
    });
    previews.forEach(({row, task, title, pending}) => {
      if (!task) return;
      row.classList.toggle('done', task.input.checked);
      row.querySelector('strong').textContent = `${task.input.checked ? '✓' : '○'} ${title}`;
      const status = row.querySelector('.status');
      status.classList.toggle('done', task.input.checked);
      status.textContent = task.input.checked ? '已完成' : pending;
    });
  }

  tasks.forEach(task => task.input.addEventListener('change', () => {
    render();
    let saved = true;
    try {
      localStorage.setItem(storageKey, JSON.stringify(Object.fromEntries(tasks.map(item => [item.id, item.input.checked]))));
    } catch {
      saved = false;
    }
    if (typeof window.toast === 'function') {
      window.toast(saved ? (task.input.checked ? '行动已标记完成' : '已恢复为待完成') : '状态已更新，但浏览器未能保存，刷新后可能丢失');
    }
  }));
  render();
  plan.dataset.ready = 'true';
})();
