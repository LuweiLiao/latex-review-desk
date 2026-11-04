import { prefs } from './storage.js';
// 选中文字后的浮动菜单：批注 / 润色
import { api, $, h, toast, short, guard } from './util.js';
import { state, on, emit } from './state.js';

let pending = null; // 当前选区
let mode = 'hidden'; // hidden | menu | form

export function initMenu() {
  on('selection', (sel) => {
    if (mode === 'form') return; // 正在填写时不打断
    pending = sel;
    if (sel.formulaReview) showFormulaForm();
    else if (sel.polish) showForm('polish');
    else showMenu();
  });
  on('hide-menu', hide);
  on('hide-quick-menu', () => { if (mode === 'menu') hide(); });
  document.addEventListener('mousedown', (ev) => {
    if (mode === 'menu' && !$('#selMenu').contains(ev.target)) hide();
  }, true);
  document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') hide(); });
}

function place(el, x, y) {
  el.hidden = false;
  const w = el.offsetWidth, hgt = el.offsetHeight;
  el.style.left = `${Math.max(8, Math.min(x, innerWidth - w - 8))}px`;
  el.style.top = `${y + hgt > innerHeight - 8 ? Math.max(8, y - hgt - 30) : y}px`;
}

function hide() {
  mode = 'hidden';
  $('#selMenu').hidden = true;
  $('#selMenu').replaceChildren();
}

function favorites() {
  const have = new Set(state.skills.map((s) => s.name));
  return state.favoriteSkills.filter((n) => have.has(n));
}

function showMenu() {
  mode = 'menu';
  const el = $('#selMenu');
  const desc = (n) => state.skills.find((s) => s.name === n)?.description || '';
  el.replaceChildren(...[
    pending.formula ? h('div', { class: 'formula-head' }, h('span', { class: 'tag' }, '公式'), h('code', {}, short(pending.quote.replace(/\s+/g, ' '), 70))) : null,
    h('div', { class: 'row' },
      h('button', { class: 'btn', onclick: () => showForm('comment') }, '批注'),
      pending.formula && h('button', { class: 'btn', title: '让公式审核 agent 只审这一个公式', onclick: guard(reviewOne) }, '审核这个公式'),
    ),
    h('div', { class: 'menu-label' }, '用 skill 润色'),
    h('div', { class: 'row wrap' },
      ...favorites().map((n) => h('button', { class: 'btn chip', title: desc(n), onclick: () => showForm('polish', n) }, n)),
      h('button', { class: 'btn chip more', onclick: () => showForm('polish') }, '更多 skill…'),
    ),
  ].filter(Boolean));
  place(el, pending.x, pending.y);
}

// 单个公式：直接建一条公式审核请求
async function reviewOne() {
  const it = await api('POST', '/api/items', { kind: 'formula', anchor: pending.anchor });
  hide();
  const off = state.agent.formula?.state === 'offline' ? '（公式审核 agent 当前离线，上线后会处理）' : '';
  toast(`已提交公式审核 ${it.id}${off}`);
  emit('select-item', { id: it.id, from: 'create' });
}

// 审核公式：本章 / 全文，一个一个交给公式审核 agent
function showFormulaForm() {
  mode = 'form';
  const el = $('#selMenu');
  const scope = h('select', {}, new Option('本章', 'chapter'), new Option('全文（按章节顺序）', 'whole'));
  scope.value = prefs.getItem('formulaScope') || 'chapter';
  const conc = h('select', { title: '同时交给 agent 的公式数；1 个最能按推导顺序审' }, ...[1, 2, 3].map((n) => new Option(`同时 ${n} 个`, n)));
  conc.value = prefs.getItem('formulaConc') || '1';
  const ta = h('textarea', { placeholder: '补充要求（可不填），例如：重点看矩阵维数和上下标' });
  const info = h('div', { class: 'muted' });
  const body = () => ({ type: 'formula', whole: scope.value === 'whole', anchor: pending.anchor });
  const upd = async () => {
    info.textContent = '统计公式…';
    try {
      const p = await api('POST', '/api/jobs/preview', body());
      info.textContent = p.count ? `共 ${p.count} 个独立公式${p.files > 1 ? `，分布在 ${p.files} 个文件` : ''}。行内公式不单独审，放在所在段落里一起看。` : '这里没有独立公式';
    } catch (e) { info.textContent = e.message; }
  };
  scope.onchange = upd;
  upd();
  const submit = async (ev) => {
    ev?.preventDefault();
    prefs.setItem('formulaScope', scope.value);
    prefs.setItem('formulaConc', conc.value);
    try {
      const job = await api('POST', '/api/jobs', { ...body(), concurrency: +conc.value, comment: ta.value });
      hide();
      const off = state.agent.formula?.state === 'offline' ? '公式审核 agent 当前离线，上线后开始。' : '';
      toast(`已开始公式审核 ${job.id}：共 ${job.total} 个公式，按顺序一个一个审。${off}`);
    } catch (e) { toast(e.message, true); }
  };
  el.replaceChildren(h('form', { onsubmit: submit },
    h('b', {}, '审核公式'),
    h('div', { class: 'qprev' }, '逐个检查：符号定义与一致性、维数、上下标与字体、推导衔接、编号与引用。有问题给修改方案或说明，没问题标“通过”。'),
    h('div', { class: 'per-para' }, h('label', {}, '范围 ', scope), conc),
    info,
    ta,
    h('div', { class: 'form-actions' },
      h('button', { type: 'button', class: 'btn', onclick: hide }, '取消'),
      h('button', { type: 'submit', class: 'btn primary' }, '开始审核'),
    ),
  ));
  place(el, pending.x, pending.y);
}

export function sortedSkills() {
  const pri = [...state.favoriteSkills, 'nature-writing', 'thesis-no-shortcomings-review'];
  const rank = (s) => { const i = pri.indexOf(s.name); return i === -1 ? 100 : i; };
  return [...state.skills].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

export function skillSelect(selected) {
  const sel = h('select', {});
  const fav = new Set(favorites());
  const groups = [['常用', sortedSkills().filter((s) => fav.has(s.name))], ['全部', sortedSkills().filter((s) => !fav.has(s.name))]];
  for (const [label, list] of groups) {
    if (!list.length) continue;
    const g = h('optgroup', { label });
    for (const s of list) g.append(new Option(s.name, s.name, false, s.name === selected));
    sel.append(g);
  }
  return sel;
}

function showForm(kind, skill) {
  mode = 'form';
  const el = $('#selMenu');
  const ta = h('textarea', { placeholder: kind === 'comment' ? '写下意见，例如：不要这样写，按正式论文写' : '补充要求（可不填），例如：只去掉 AI 腔，不改术语' });
  let skillSel = null, desc = null;
  const parts = [h('div', { class: 'qprev' }, short(pending.quote, 300))];
  if (kind === 'polish') {
    skillSel = skillSelect(skill || prefs.getItem('lastSkill') || state.defaultSkill);
    desc = h('div', { class: 'skill-desc' });
    const upd = () => { desc.textContent = state.skills.find((s) => s.name === skillSel.value)?.description || ''; };
    skillSel.onchange = upd;
    upd();
    parts.push(h('label', {}, '使用 skill'), skillSel, desc);
  }
  parts.push(ta);
  // 逐段润色：开启后把选区拆成正文段，一段一段交给 agent
  let perPara = null, conc = null;
  if (kind === 'polish') {
    perPara = h('input', { type: 'checkbox' });
    perPara.checked = pending.perParagraph ?? prefs.getItem('perParagraph') === '1';
    conc = h('select', { title: '同时交给 agent 的段数' }, ...[1, 2, 3].map((n) => new Option(`同时 ${n} 段`, n)));
    conc.value = prefs.getItem('perParaConc') || '1';
    const info = h('span', { class: 'muted' });
    const upd = async () => {
      conc.disabled = !perPara.checked;
      info.textContent = '';
      if (!perPara.checked) return;
      info.textContent = '计算段数…';
      try {
        const p = await api('POST', '/api/jobs/preview', { anchor: pending.anchor });
        info.textContent = p.count ? `共 ${p.count} 段（公式、图表、标题自动跳过）` : '这里没有可润色的正文段';
      } catch (e) { info.textContent = e.message; }
    };
    perPara.onchange = upd;
    upd();
    parts.push(h('div', { class: 'per-para' }, h('label', {}, perPara, ' 逐段润色'), conc, info));
  }
  const submit = async (ev) => {
    ev?.preventDefault();
    const body = { kind, comment: ta.value, anchor: pending.anchor };
    if (skillSel) { body.skill = skillSel.value; prefs.setItem('lastSkill', skillSel.value); }
    try {
      if (perPara) prefs.setItem('perParagraph', perPara.checked ? '1' : '0');
      if (perPara?.checked) {
        prefs.setItem('perParaConc', conc.value);
        const job = await api('POST', '/api/jobs', { anchor: pending.anchor, skill: body.skill, comment: ta.value, concurrency: +conc.value });
        hide();
        window.getSelection()?.removeAllRanges();
        toast(`已开始逐段润色 ${job.id}：共 ${job.total} 段，将按顺序处理`);
        return;
      }
      const it = await api('POST', '/api/items', body);
      hide();
      window.getSelection()?.removeAllRanges();
      const off = !state.ai?.configured && state.agent.state === 'offline' ? '（请先配置 API）' : '';
      toast(`已提交 ${it.id}${it.anchor.approximate ? '，位置为近似匹配' : ''}${off}`);
      emit('select-item', { id: it.id, from: 'create' });
    } catch (e) { toast(e.message, true); }
  };
  ta.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) submit(ev); });
  const form = h('form', { onsubmit: submit },
    h('b', {}, kind === 'comment' ? '添加批注' : `请求润色`),
    ...parts,
    h('div', { class: 'form-actions' },
      h('button', { type: 'button', class: 'btn', onclick: hide }, '取消'),
      h('button', { type: 'submit', class: 'btn primary' }, '提交（Ctrl+Enter）'),
    ),
  );
  el.replaceChildren(form);
  place(el, pending.x, pending.y);
  ta.focus();
}
