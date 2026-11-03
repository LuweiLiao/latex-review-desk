// 侧栏顶部的逐段润色任务条
import { api, $, h, guard } from './util.js';
import { state } from './state.js';
import { railMode, scopeFile } from './sidebar.js';

const LABEL = { running: '进行中', paused: '已暂停', done: '已完成', cancelled: '已取消' };

export function renderJobs() {
  const bar = $('#jobBar');
  const scope = scopeFile();
  // 全文公式审核（file 为空）在每一章都显示
  const list = state.jobs.filter((j) => (!scope || !j.file || j.file === scope) && (j.status === 'running' || j.status === 'paused' || (!railMode() && Date.now() - j.updatedAt < 6 * 3600_000)));
  bar.replaceChildren(...list.map(jobRow));
}

function jobRow(j) {
  const c = j.counts;
  const handled = c.proposed + c.replied + c.accepted + c.rejected + c.skipped;
  const pct = j.total ? Math.round((handled / j.total) * 100) : 0;
  const b = (label, fn, cls = 'btn small') => h('button', { class: cls, onclick: guard(fn) }, label);
  const formula = j.type === 'formula';
  const parts = formula ? [
    c.claimed && `审核中 ${c.claimed}`,
    c.pass && `通过 ${c.pass}`,
    c.issue && `有问题 ${c.issue}`,
    c.unsure && `拿不准 ${c.unsure}`,
    c.accepted && `已改 ${c.accepted}`,
    c.skipped && `跳过 ${c.skipped}`,
  ].filter(Boolean).join(' · ') : [
    c.claimed && `处理中 ${c.claimed}`,
    c.pending && `排队 ${c.pending}`,
    c.proposed && `待确认 ${c.proposed}`,
    c.accepted && `已接受 ${c.accepted}`,
    c.replied && `无需修改 ${c.replied}`,
    c.rejected && `已驳回 ${c.rejected}`,
    c.skipped && `跳过 ${c.skipped}`,
  ].filter(Boolean).join(' · ');
  return h('div', { class: `job job-${j.status}` },
    h('div', { class: 'job-head' },
      h('b', {}, formula ? '公式审核' : '逐段润色'),
      !formula && h('span', { class: 'tag skill' }, j.skill),
      h('span', { class: 'job-label', title: j.file }, j.label === j.file ? state.fileTitles[j.file] || j.label : j.label),
      h('span', { class: 'spacer' }),
      h('span', { class: 'muted' }, `${LABEL[j.status]} ${handled}/${j.total}`),
    ),
    h('div', { class: 'job-prog' }, h('div', { style: `width:${pct}%` })),
    h('div', { class: 'job-foot' },
      h('span', { class: 'muted' }, parts || (formula ? '等待公式审核 agent 领取第一个公式' : '等待 agent 领取第一段')),
      h('span', { class: 'spacer' }),
      j.status === 'running' && b('暂停', () => api('POST', `/api/jobs/${j.id}/pause`)),
      j.status === 'paused' && b('继续', () => api('POST', `/api/jobs/${j.id}/resume`), 'btn small primary'),
      (j.status === 'running' || j.status === 'paused') && b('取消', async () => { if (confirm(formula ? '取消这个公式审核？还没开始的公式会撤回，已有结论保留。' : '取消这个逐段任务？还没开始处理的段会撤回，已出的方案保留。')) await api('POST', `/api/jobs/${j.id}/cancel`); }, 'btn small danger'),
      (j.status === 'done' || j.status === 'cancelled') && b('收起', () => api('DELETE', `/api/jobs/${j.id}`)),
    ),
  );
}
