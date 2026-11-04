import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';

const PROVIDERS = {
  openai: { baseUrl: 'https://api.openai.com/v1', apiFormat: 'chat' },
  anthropic: { baseUrl: 'https://api.anthropic.com/v1', apiFormat: 'messages' },
  gemini: { baseUrl: 'https://generativelanguage.googleapis.com/v1beta', apiFormat: 'generateContent' },
};
export const AI_DEFAULTS = Object.freeze({ enabled: true, provider: 'openai', ...PROVIDERS.openai, apiKey: '', model: '', timeoutMs: 120000, maxTokens: 4096, concurrency: 1 });

function merge(current, patch) {
  const next = { ...current };
  if (patch.provider && patch.provider !== current.provider) Object.assign(next, PROVIDERS[patch.provider]);
  for (const key of Object.keys(AI_DEFAULTS)) {
    if (patch[key] !== undefined && key !== 'apiKey') next[key] = patch[key];
  }
  if (typeof patch.apiKey === 'string' && patch.apiKey.trim()) next.apiKey = patch.apiKey.trim();
  if (patch.clearApiKey === true) next.apiKey = '';
  if (!PROVIDERS[next.provider]) throw new Error('不支持的 AI 服务商');
  const formats = next.provider === 'openai' ? ['chat', 'responses'] : [PROVIDERS[next.provider].apiFormat];
  if (!formats.includes(next.apiFormat)) throw new Error('API 格式与服务商不匹配');
  next.baseUrl = String(next.baseUrl).trim().replace(/\/+$/, '');
  next.model = String(next.model).trim();
  next.enabled = next.enabled === true;
  for (const [key, min, max] of [['timeoutMs', 1, 3600000], ['maxTokens', 1, 1000000], ['concurrency', 1, 3]]) {
    next[key] = Number(next[key]);
    if (!Number.isInteger(next[key]) || next[key] < min || next[key] > max) throw new Error(`${key} 应为 ${min} 到 ${max} 的整数`);
  }
  const url = new URL(next.baseUrl);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('baseUrl 应为 HTTP 或 HTTPS 地址');
  return next;
}

export class AiSettings extends EventEmitter {
  constructor(dataDir, defaults = {}) {
    super();
    this.file = path.join(dataDir, 'ai-settings.json');
    this.value = merge(AI_DEFAULTS, defaults);
    if (fs.existsSync(this.file)) {
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.value = merge(this.value, saved);
      if (typeof saved.apiKey === 'string') this.value.apiKey = saved.apiKey;
    }
  }

  get() { return { ...this.value }; }
  public() {
    const { apiKey, ...rest } = this.value;
    return { ...rest, hasApiKey: !!apiKey };
  }
  forRequest(patch = {}) { return merge(this.value, patch); }
  update(patch = {}) {
    const next = this.forRequest(patch);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file + '.tmp', JSON.stringify(next, null, 2), 'utf8');
    fs.renameSync(this.file + '.tmp', this.file);
    this.value = next;
    this.emit('changed', this.public());
    return this.public();
  }
}
