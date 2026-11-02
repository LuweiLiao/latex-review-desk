// 全局状态和简单的事件总线
export const state = {
  items: [],
  files: [],
  fileTitles: {},
  openFile: null, // 左侧当前打开的文件
  skills: [],
  defaultSkill: '',
  favoriteSkills: [],
  jobs: [],
  agent: { state: 'offline' },
  compile: {},
  pdf: null,
  dirty: [],
  activeId: null,
  mode: 'read',
};

export function markedItems(open) {
  const all = document.getElementById('showMarks')?.checked;
  return state.items.filter((it) => !it.stale && (it.id === state.activeId || (all && open.has(it.status))));
}

const handlers = new Map();
export function on(ev, fn) {
  if (!handlers.has(ev)) handlers.set(ev, new Set());
  handlers.get(ev).add(fn);
}
export function emit(ev, data) {
  for (const fn of handlers.get(ev) || []) fn(data);
}
