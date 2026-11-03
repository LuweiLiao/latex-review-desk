let beforeWrite = null;
export function setBeforeWrite(fn) { beforeWrite = fn; }

export async function api(method, url, body) {
  if (method !== 'GET' && beforeWrite && !url.startsWith('/api/file')) await beforeWrite();
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
  return data;
}

export const $ = (sel, root = document) => root.querySelector(sel);

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'html') el.innerHTML = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

export function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

export function toast(msg, isErr = false) {
  const el = h('div', { class: 'toast' + (isErr ? ' err' : '') }, msg);
  $('#toasts').append(el);
  setTimeout(() => el.remove(), isErr ? 6000 : 3000);
}

export function guard(fn) {
  return async (...a) => {
    try { return await fn(...a); } catch (e) { toast(e.message, true); }
  };
}

export const STATUS = {
  pending: '待处理',
  claimed: '处理中',
  proposed: '待确认',
  replied: '已回复',
  accepted: '已接受',
  rejected: '已驳回',
};

// 公式审核的结论
export const VERDICT = { pass: '通过', issue: '有问题', unsure: '拿不准' };

export const OPEN = new Set(['pending', 'claimed', 'proposed', 'replied']);

export function timeAgo(t) {
  const s = (Date.now() - t) / 1000;
  if (s < 60) return '刚刚';
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  return new Date(t).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function short(s, n = 60) {
  s = String(s).replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n) + '…' : s;
}
