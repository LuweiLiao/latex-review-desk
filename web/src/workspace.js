import { $, h, api, guard, toast } from './util.js';
import { state, on } from './state.js';
import { openFile, save, hasUnsavedSource } from './source.js';
import { prefs } from './storage.js';

let tree = null;
let agentConfig = null;
let editingAgentId = null;
let importing = false;
let environment = null;

function status(selector, message, error = false) {
  const el = $(selector);
  el.textContent = message;
  el.classList.toggle('err', error);
}

async function inDialog(selector, fn) {
  try { await fn(); } catch (e) { status(selector, e.message, true); }
}

async function leaveProject() {
  await save();
  if (hasUnsavedSource()) throw new Error('当前文件尚未保存，请先处理保存失败或冲突。');
}

async function activate(project) {
  await leaveProject();
  await api('POST', `/api/projects/${encodeURIComponent(project.id)}/activate`, {});
  const url = new URL(location.href);
  url.searchParams.set('project', project.id);
  // 完整重载同时清除编辑器、PDF、批注和对照缓存。
  location.assign(url.pathname + url.search + url.hash);
}

export function renderWorkspace() {
  const select = $('#projectSelect');
  select.replaceChildren(...state.projects.map((p) => new Option(p.name, p.id)));
  if (state.projectId) select.value = state.projectId;
  else { select.prepend(new Option(state.projects.length ? '选择要打开的项目' : '尚未打开项目', '')); select.value = ''; }
  $('#projectRoot').textContent = state.project?.projectRoot || '打开本地原目录，或导入文件夹副本。';
  $('#projectRoot').title = state.project?.projectRoot || '';
  renderTree();
  renderAiStatus(state.ai);
  const active = !!state.projectId;
  $('#projectSettingsBtn').disabled = !active;
  for (const id of ['compileBtn', 'recipeSelect', 'polishChapterBtn', 'formulaReviewBtn', 'toPdfBtn']) $("#" + id).disabled = !active || (id === 'compileBtn' || id === 'recipeSelect') && !!state.compile?.running;
}

function fromFiles(files) {
  const root = { type: 'directory', children: [] };
  for (const path of files) {
    let node = root;
    const pieces = path.split('/');
    for (let i = 0; i < pieces.length; i++) {
      const part = pieces[i];
      const directory = i < pieces.length - 1;
      let child = node.children.find((n) => n.name === part);
      if (!child) { child = { name: part, path: pieces.slice(0, i + 1).join('/'), type: directory ? 'directory' : 'file', ...(directory ? { children: [] } : {}) }; node.children.push(child); }
      node = child;
    }
  }
  return root;
}

function renderTree() {
  const container = $('#projectFiles');
  const root = tree || fromFiles(state.files);
  if (!root.children?.length) {
    container.replaceChildren(h('p', { class: 'muted' }, state.projectId ? '目录内还没有文件。' : '打开项目后，文件会显示在这里。'));
    return;
  }
  let closed;
  try { closed = new Set(JSON.parse(prefs.getItem('closedFolders') || '[]')); } catch { closed = new Set(); }
  const render = (node) => {
    if (node.type === 'directory') {
      const el = h('details', { class: 'file-tree', ...(closed.has(node.path) ? {} : { open: true }) }, h('summary', {}, node.name), ...(node.children || []).map(render));
      el.addEventListener('toggle', () => {
        if (el.open) closed.delete(node.path); else closed.add(node.path);
        prefs.setItem('closedFolders', JSON.stringify([...closed]));
      });
      return el;
    }
    const readable = state.files.includes(node.path);
    const pdf = /\.pdf$/i.test(node.path) && node.path === state.project?.pdf;
    return h('button', {
      class: 'tree-file' + (state.openFile === node.path ? ' active' : '') + (!readable && !pdf ? ' unavailable' : ''),
      title: readable ? (state.fileTitles[node.path] || node.path) : pdf ? '查看编译后的 PDF' : `${node.path}（此文件不在源码编辑范围）`,
      'data-file': node.path,
      onclick: guard(async () => {
        if (readable) { $('#readView').hidden = false; onRead(); await openFile(node.path); }
        else if (pdf) onRead();
        else toast('该文件作为项目资源保留；可编辑的源码由项目的源文件范围决定。');
      }),
    }, h('span', { 'aria-hidden': true }, readable ? '≡' : pdf ? '▤' : '·'), h('span', {}, node.name));
  };
  container.replaceChildren(...root.children.map(render));
}

let onRead = () => {};

function openProjectSettings() {
  const project = state.project;
  if (!project) return;
  $('#projectSettingsName').value = project.name;
  const candidates = project.mainTexCandidates || [];
  const paths = [...new Set([...candidates, ...state.files.filter((file) => /\.tex$/i.test(file)), ...(project.mainTex ? [project.mainTex] : [])])];
  $('#projectMainTex').replaceChildren(new Option('暂不指定主文件', ''), ...paths.map((path) => new Option(path + (candidates.includes(path) ? '（检测到主文件）' : ''), path)));
  $('#projectMainTex').value = project.mainTex || '';
  $('#mainTexHint').textContent = candidates.length > 1 ? '检测到多个主文件，请选择本项目需要编译的文件。' : '主文件通常包含 documentclass 和 document 环境。';
  const recipes = [...$('#recipeSelect').options].map((option) => option.value);
  $('#projectDefaultRecipe').replaceChildren(...recipes.map((recipe) => new Option(recipe, recipe)));
  $('#projectDefaultRecipe').value = project.defaultRecipe || $('#recipeSelect').value;
  $('#projectWritingRules').value = Array.isArray(project.writingRules) ? project.writingRules.join('\n') : project.writingRules || '';
  status('#projectSettingsStatus', '保存后会重新载入当前项目。');
  $('#projectSettingsDialog').showModal();
}

async function loadTree() {
  if (!state.projectId) return;
  try { tree = await api('GET', `/api/projects/${encodeURIComponent(state.projectId)}/tree`); renderTree(); }
  catch (e) { toast(`文件树加载失败：${e.message}`, true); }
}

async function browseFolder(initialPath = '') {
  status('#projectDialogStatus', '请在系统窗口中选择文件夹…');
  const result = await api('POST', '/api/folders/choose', { initialPath });
  if (result.cancelled) { status('#projectDialogStatus', '已取消选择。'); return null; }
  $('#folderPath').value = result.path;
  status('#projectDialogStatus', '已选择文件夹，可直接打开。');
  return result.path;
}

async function openNativeProject() {
  const button = $('#openProjectBtn');
  button.disabled = true;
  try {
    await leaveProject();
    const folder = await browseFolder(state.project?.projectRoot || '');
    if (!folder) return;
    const project = await api('POST', '/api/projects', { projectRoot: folder });
    await activate(project);
  } catch (error) {
    $('#projectDialog').showModal();
    status('#projectDialogStatus', error.message, true);
  } finally { button.disabled = false; }
}

function fileBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = () => reject(new Error(`无法读取 ${file.name}`));
    reader.readAsDataURL(file);
  });
}

async function importFiles(entries) {
  if (importing || !entries.length) return;
  importing = true;
  $('#uploadProjectBtn').disabled = true;
  try {
    await leaveProject();
    const firstParts = entries[0].path.split('/');
    const sharedRoot = firstParts.length > 1 && entries.every((f) => f.path.startsWith(firstParts[0] + '/')) ? firstParts[0] : '';
    const files = [];
    for (const entry of entries) {
      status('#importStatus', `读取文件 ${files.length + 1}/${entries.length}：${entry.file.name}`);
      files.push({ path: sharedRoot ? entry.path.slice(sharedRoot.length + 1) : entry.path, content: await fileBase64(entry.file), encoding: 'base64' });
    }
    status('#importStatus', `正在复制 ${files.length} 个文件…`);
    const project = await api('POST', '/api/projects/import', { name: sharedRoot || '导入项目', files });
    status('#importStatus', '副本已导入，正在打开…');
    await activate(project);
  } catch (e) { status('#importStatus', `导入失败：${e.message}`, true); }
  finally { importing = false; $('#uploadProjectBtn').disabled = false; $('#projectUpload').value = ''; }
}

async function collectEntry(entry, prefix = '') {
  const path = prefix + entry.name;
  if (entry.isFile) return [{ path, file: await new Promise((resolve, reject) => entry.file(resolve, reject)) }];
  if (!entry.isDirectory) return [];
  const reader = entry.createReader();
  const files = [];
  for (;;) {
    const batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
    if (!batch.length) break;
    for (const child of batch) files.push(...await collectEntry(child, path + '/'));
  }
  return files;
}

function apiForm() {
  return {
    agentId: editingAgentId,
    name: $('#agentName').value.trim(),
    systemPrompt: $('#agentSystemPrompt').value,
    format: $('#apiFormat').value,
    baseUrl: $('#apiBaseUrl').value.trim(),
    model: $('#apiModel').value.trim(),
    enabled: $('#apiEnabled').checked,
    concurrency: Number($('#apiConcurrency').value),
    ...($('#apiKey').value.trim() ? { apiKey: $('#apiKey').value.trim() } : {}),
  };
}

function selectAgent(id) {
  const config = agentConfig.agents.find((agent) => agent.id === id);
  if (!config) return;
  editingAgentId = config.id;
  $('#agentName').value = config.name;
  $('#agentSystemPrompt').value = config.systemPrompt || '';
  $('#apiFormat').value = config.format;
  $('#apiBaseUrl').value = config.baseUrl || '';
  $('#apiModel').value = config.model || '';
  $('#apiEnabled').checked = !!config.enabled;
  $('#apiConcurrency').value = config.concurrency || 1;
  $('#apiKey').value = '';
  $('#apiKey').placeholder = config.hasApiKey ? '已保存密钥；留空保留原密钥' : '输入密钥';
  $('#apiKeyHint').textContent = config.hasApiKey ? '此 Agent 的密钥已保存在本机。' : '';
  $('#deleteAgentBtn').disabled = agentConfig.agents.length < 2;
  $('#setDefaultAgentBtn').disabled = config.id === agentConfig.activeAgentId;
  renderAgentList();
}

function renderAgentList() {
  $('#agentList').replaceChildren(...agentConfig.agents.map((agent) => h('button', {
    type: 'button', class: 'btn agent-list-entry' + (agent.id === editingAgentId ? ' active' : ''),
    onclick: () => { selectAgent(agent.id); status('#apiSettingsStatus', '编辑后点击“保存 Agent”。'); },
  }, agent.name + (agent.id === agentConfig.activeAgentId ? ' · 默认' : ''), h('small', {}, agent.model || '尚未填写模型'))));
}

async function refreshAgentConfig(selected = editingAgentId) {
  agentConfig = await api('GET', '/api/ai/config');
  const agents = agentConfig.agents;
  $('#activeAgentSelect').replaceChildren(...agents.map((agent) => new Option(agent.name, agent.id)));
  $('#activeAgentSelect').value = agentConfig.activeAgentId;
  for (const kind of ['polish', 'comment', 'formula']) {
    const select = $('#' + kind + 'AgentSelect');
    select.replaceChildren(new Option('使用默认 Agent', ''), ...agents.map((agent) => new Option(agent.name, agent.id)));
    select.value = agentConfig.assignments[kind] || '';
  }
  selectAgent(agents.some((agent) => agent.id === selected) ? selected : agentConfig.activeAgentId);
}

async function openApiSettings() {
  $('#apiDialog').showModal();
  status('#apiSettingsStatus', '正在读取 Agent 配置…');
  await inDialog('#apiSettingsStatus', async () => {
    await refreshAgentConfig();
    status('#apiSettingsStatus', '可保存多个 Agent，并分别指定给润色、批注和公式审核。');
  });
}

export function renderAiStatus(ai) {
  const el = $('#apiTaskStatus');
  if (!ai) { el.textContent = 'API 尚未配置'; return; }
  const pending = state.items.filter((it) => it.status === 'pending').length;
  const labels = { unconfigured: 'API 尚未配置', idle: 'API 已就绪', busy: 'API 正在处理', error: 'API 处理出错', disabled: 'API 未启用' };
  const label = ai.enabled === false ? 'API 未启用' : labels[ai.state] || (ai.busy ? 'API 正在处理' : ai.configured ? 'API 已就绪' : 'API 尚未配置');
  el.replaceChildren(h('div', {}, label), h('div', {}, `处理中 ${Number(ai.busy) || 0} · 等待 ${pending}`));
  if (ai.activeIds?.length) el.append(h('div', {}, `当前：${ai.activeIds.join('、')}`));
  const runningJobs = state.jobs.filter((job) => job.status === 'running' || job.status === 'paused');
  if (runningJobs.length) {
    const total = runningJobs.reduce((sum, job) => sum + job.total, 0);
    const done = runningJobs.reduce((sum, job) => sum + ['proposed', 'replied', 'accepted', 'rejected', 'skipped'].reduce((n, key) => n + (job.counts[key] || 0), 0), 0);
    el.append(h('progress', { max: total || 1, value: done }), h('div', {}, `逐段任务：${done}/${total}`));
  }
  if (ai.total > 0) el.append(h('progress', { max: ai.total, value: ai.completed || 0 }), h('span', {}, `${ai.completed || 0}/${ai.total}`));
  if (ai.lastError) el.append(h('div', { class: 'dialog-status err' }, typeof ai.lastError === 'string' ? ai.lastError : ai.lastError.message || '请求失败'));
}

function renderEnvironment() {
  const tools = environment?.tools || {};
  const check = environment?.compile;
  const engine = ['xelatex', 'lualatex', 'pdflatex'].find((name) => tools[name]?.available);
  const btn = $('#texEnvironmentBtn');
  btn.textContent = check ? check.ok ? 'TeX 环境：最小编译通过' : 'TeX 环境：编译检查未通过' : engine ? 'TeX 环境：已找到编译器' : 'TeX 环境：未找到编译器';
  btn.className = 'environment-status' + (check ? check.ok ? ' ok' : ' err' : engine ? '' : ' err');
  const details = $('#texEnvironmentDetails');
  details.replaceChildren(h('p', { class: 'muted' }, (environment?.distributions || []).map((d) => `${d.name} ${d.version}`).join(' · ') || '未识别到 TeX 发行版'), ...Object.entries(tools).map(([name, tool]) => h('div', { class: 'environment-row' }, h('b', {}, name), h('span', {}, tool.available ? '已找到' : '未找到'), tool.path && h('code', {}, tool.path), tool.version && h('span', { class: 'muted' }, tool.version))));
  if (check) details.append(h('p', { class: check.ok ? '' : 'dialog-status err' }, `${check.engine}：${check.ok ? '临时最小文档已生成 PDF 和 SyncTeX。' : '临时最小文档编译未通过。'}`), !check.ok && h('pre', {}, check.log || check.message));
  details.append(h('p', { class: 'muted' }, '检查在临时目录中进行。项目编译仍使用顶部选择的配方。'));
}

async function checkEnvironment(refresh = false) {
  $('#texEnvironmentBtn').textContent = 'TeX 环境：检查中…';
  $('#refreshEnvironmentBtn').disabled = true;
  try {
    environment = await api('GET', '/api/environment' + (refresh ? '?refresh=1' : ''));
    renderEnvironment();
    const engine = ['xelatex', 'lualatex', 'pdflatex'].find((name) => environment.tools?.[name]?.available);
    if (engine) {
      $('#texEnvironmentBtn').textContent = 'TeX 环境：检查最小编译…';
      const check = await api('POST', '/api/environment/check', { engine, ...(refresh ? { refresh: true } : {}) });
      environment = check.tools ? check : { ...environment, compile: check };
      renderEnvironment();
    }
  } catch (e) { $('#texEnvironmentBtn').textContent = 'TeX 环境：检查失败'; status('#texEnvironmentDetails', e.message, true); }
  finally { $('#refreshEnvironmentBtn').disabled = false; }
}

export function initWorkspace({ setReadMode }) {
  onRead = setReadMode;
  const panel = $('#projectPanel');
  panel.hidden = prefs.getItem('projectPanelClosed') === '1';
  const syncToggle = () => {
    $('#toggleProjects').setAttribute('aria-expanded', String(!panel.hidden));
    $('#toggleProjects').title = $('#toggleProjects').ariaLabel = panel.hidden ? '展开项目和文件' : '收起项目和文件';
  };
  syncToggle();
  $('#toggleProjects').onclick = () => { panel.hidden = !panel.hidden; prefs.setItem('projectPanelClosed', panel.hidden ? '1' : '0'); syncToggle(); };
  $('#foldFilesBtn').onclick = () => $('#projectFiles').querySelectorAll('details').forEach((d) => { d.open = false; });
  $('#projectSettingsBtn').onclick = openProjectSettings;
  $('#projectSettingsForm').onsubmit = async (e) => {
    e.preventDefault();
    e.submitter.disabled = true;
    await inDialog('#projectSettingsStatus', async () => {
      await leaveProject();
      status('#projectSettingsStatus', '正在保存…');
      const defaultRecipe = $('#projectDefaultRecipe').value;
      await api('PATCH', `/api/projects/${encodeURIComponent(state.projectId)}`, {
        name: $('#projectSettingsName').value.trim(), mainTex: $('#projectMainTex').value,
        ...(defaultRecipe ? { defaultRecipe } : {}), writingRules: $('#projectWritingRules').value,
      });
      if (defaultRecipe) prefs.setItem('recipe', defaultRecipe);
      const url = new URL(location.href);
      url.searchParams.set('project', state.projectId);
      location.assign(url.pathname + url.search + url.hash);
    });
    e.submitter.disabled = false;
  };
  $('#projectSelect').onchange = guard(async (e) => {
    const id = e.target.value;
    e.target.disabled = true;
    try { await activate(state.projects.find((p) => p.id === id)); }
    finally { e.target.value = state.projectId || ''; e.target.disabled = false; }
  });
  $('#openProjectBtn').onclick = openNativeProject;
  document.querySelectorAll('[data-close-dialog]').forEach((b) => { b.onclick = () => b.closest('dialog').close(); });
  $('#browseFolderBtn').onclick = () => inDialog('#projectDialogStatus', () => browseFolder($('#folderPath').value.trim()));
  $('#openProjectForm').onsubmit = async (e) => {
    e.preventDefault();
    const button = e.submitter;
    if (button) button.disabled = true;
    await inDialog('#projectDialogStatus', async () => {
      await leaveProject();
      status('#projectDialogStatus', '正在打开项目…');
      const project = await api('POST', '/api/projects', { projectRoot: $('#folderPath').value.trim(), ...($('#projectName').value.trim() ? { name: $('#projectName').value.trim() } : {}) });
      await activate(project);
    });
    if (button) button.disabled = false;
  };
  $('#uploadProjectBtn').onclick = () => $('#projectUpload').click();
  $('#projectUpload').onchange = (e) => importFiles([...e.target.files].map((file) => ({ file, path: file.webkitRelativePath || file.name })));
  let dragDepth = 0;
  panel.addEventListener('dragenter', (e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); dragDepth++; panel.classList.add('drag-over'); } });
  panel.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } });
  panel.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; panel.classList.remove('drag-over'); } });
  panel.addEventListener('drop', guard(async (e) => {
    e.preventDefault(); dragDepth = 0; panel.classList.remove('drag-over');
    if (importing) return;
    const items = [...e.dataTransfer.items];
    const entries = items.map((item) => item.webkitGetAsEntry?.()).filter(Boolean);
    const fallback = [...e.dataTransfer.files].map((file) => ({ file, path: file.webkitRelativePath || file.name }));
    const files = [];
    for (const entry of entries) files.push(...await collectEntry(entry));
    await importFiles(entries.length ? files : fallback);
  }));
  $('#apiSettingsBtn').onclick = openApiSettings;
  $('#apiRunBtn').onclick = openApiSettings;
  $('#apiFormat').onchange = () => {
    const defaults = { openai: 'https://api.openai.com/v1', 'openai-responses': 'https://api.openai.com/v1', anthropic: 'https://api.anthropic.com/v1', gemini: 'https://generativelanguage.googleapis.com/v1beta' };
    if (Object.values(defaults).includes($('#apiBaseUrl').value.trim())) $('#apiBaseUrl').value = defaults[$('#apiFormat').value];
  };
  $('#apiSettingsForm').onsubmit = async (e) => {
    e.preventDefault();
    e.submitter.disabled = true;
    await inDialog('#apiSettingsStatus', async () => {
      await api('PUT', `/api/ai/agents/${editingAgentId}`, apiForm());
      await refreshAgentConfig();
      $('#apiKey').value = '';
      $('#apiKey').placeholder = '留空保留已保存的密钥';
      status('#apiSettingsStatus', 'Agent 已保存。');
      state.ai = await api('GET', '/api/ai/status'); renderAiStatus(state.ai);
    });
    e.submitter.disabled = false;
  };
  $('#testApiBtn').onclick = async () => {
    if (!$('#apiSettingsForm').reportValidity()) return;
    $('#testApiBtn').disabled = true;
    status('#apiSettingsStatus', '正在测试连接…');
    await inDialog('#apiSettingsStatus', async () => {
      const result = await api('POST', '/api/ai/test', apiForm());
      status('#apiSettingsStatus', result.message || (result.ok ? '连接成功。' : '连接失败。'), !result.ok);
    });
    $('#testApiBtn').disabled = false;
  };
  $('#addAgentBtn').onclick = () => inDialog('#apiSettingsStatus', async () => {
    const agent = await api('POST', '/api/ai/agents', { name: '新 Agent' });
    await refreshAgentConfig(agent.id);
    $('#agentName').focus();
    status('#apiSettingsStatus', '填写这个 Agent 的接口、模型和密钥后保存。');
  });
  $('#setDefaultAgentBtn').onclick = () => inDialog('#apiSettingsStatus', async () => {
    await api('PUT', '/api/ai/config', { activeAgentId: editingAgentId });
    await refreshAgentConfig();
    status('#apiSettingsStatus', '已设为默认 Agent。');
  });
  $('#deleteAgentBtn').onclick = () => inDialog('#apiSettingsStatus', async () => {
    await api('DELETE', `/api/ai/agents/${editingAgentId}`);
    await refreshAgentConfig(null);
    status('#apiSettingsStatus', 'Agent 已删除。');
  });
  $('#saveAgentAssignmentsBtn').onclick = () => inDialog('#apiSettingsStatus', async () => {
    const assignments = Object.fromEntries(['polish', 'comment', 'formula'].map((kind) => [kind, $('#' + kind + 'AgentSelect').value]));
    await api('PUT', '/api/ai/config', { assignments });
    status('#apiSettingsStatus', '任务分工已保存，新的请求将使用指定的 Agent。');
  });
  $('#activeAgentSelect').onchange = guard(async (event) => {
    await api('PUT', '/api/ai/config', { activeAgentId: event.target.value });
    await refreshAgentConfig();
    state.ai = await api('GET', '/api/ai/status'); renderAiStatus(state.ai);
  });
  void refreshAgentConfig().catch((error) => toast(error.message, true));
  $('#texEnvironmentBtn').onclick = () => $('#texDialog').showModal();
  $('#refreshEnvironmentBtn').onclick = () => checkEnvironment(true);
  on('file-opened', () => document.querySelectorAll('.tree-file').forEach((button) => button.classList.toggle('active', button.dataset.file === state.openFile)));
  renderWorkspace();
  void loadTree();
  void checkEnvironment();
}
