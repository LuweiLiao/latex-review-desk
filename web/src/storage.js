// 文件位置、选中批注和阅读状态按项目分别保存。
let projectId = 'default';
export function setProjectScope(id) { projectId = String(id || 'default'); }
const keyOf = (key) => `thesis-review:${encodeURIComponent(projectId)}:${key}`;
export const prefs = {
  getItem: (key) => localStorage.getItem(keyOf(key)),
  setItem: (key, value) => localStorage.setItem(keyOf(key), value),
  removeItem: (key) => localStorage.removeItem(keyOf(key)),
};
