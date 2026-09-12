// Run against a disposable local origin through ego-browser, not production.
import assert from 'node:assert/strict';

export async function verifyActionPlan(page) {
  const ids = ['rewrite-project', 'shortlist-jobs', 'apply-jobs', 'project-case', 'review-consultation'];
  const toggle = id => page.click(`[data-plan-task="${id}"] input`);
  const openPlan = async () => {
    await page.waitForFunction(() => document.getElementById('myActionPlan')?.dataset.ready === 'true', undefined, {timeout: 10000});
    await page.evaluate(() => showPage('myActionPlan'));
  };
  const check = async completed => {
    const state = await page.evaluate(() => ({
      count: document.querySelector('.plan-ring b').textContent,
      checked: document.querySelectorAll('[data-plan-task] input:checked').length,
      remaining: document.querySelector('.plan-meta strong').textContent,
      percent: document.querySelector('.plan-ring').style.getPropertyValue('--plan-progress'),
      bar: document.querySelector('.plan-summary .progress span').style.width,
      aria: document.querySelector('.plan-ring').getAttribute('aria-valuenow'),
      home: document.querySelector('[data-plan-count]').textContent,
      homeBar: document.querySelector('.goalcard .progress span').style.width,
      badges: [...document.querySelectorAll('[data-plan-task]')].every(row => row.querySelector('em').textContent === (row.querySelector('input').checked ? '已完成' : row.dataset.planDue)),
      previews: [...document.querySelectorAll('[data-plan-preview]')].every(row => {
        const input = document.querySelector(`[data-plan-task="${row.dataset.planPreview}"] input`);
        return row.classList.contains('done') === input.checked && (row.querySelector('.status').textContent === '已完成') === input.checked;
      }),
    }));
    assert.deepEqual(state, {
      count: `${completed}/5`, checked: completed, remaining: `${5-completed} 项`,
      percent: `${completed*20}%`, bar: `${completed*20}%`, aria: String(completed),
      home: `${completed}/5`, homeBar: `${completed*20}%`, badges: true, previews: true,
    });
  };

  await page.reload();
  await openPlan();
  await check(1);
  await toggle('apply-jobs');
  await check(2);
  await toggle('apply-jobs');
  await check(1);
  await toggle('rewrite-project');
  await check(0);
  for (const id of ids) await toggle(id);
  await check(5);
  await page.reload();
  await openPlan();
  await check(5);
  await page.evaluate(() => showPage('my'));
  await check(5);
  await page.evaluate(() => showPage('experts'));
  await check(5);

  // Corrupt data must fall back to defaults instead of stopping initialization.
  await page.evaluate(() => localStorage.setItem('zhishengji.action-plan.v1', '{invalid'));
  await page.reload();
  await openPlan();
  await check(1);
  await toggle('apply-jobs');
  await page.reload();
  await openPlan();
  await check(2);
  console.log('PASS: toggle/undo, 0/5, 5/5, progress ring/bar/counts, badges, home previews, reload persistence, corrupt storage recovery');
}
