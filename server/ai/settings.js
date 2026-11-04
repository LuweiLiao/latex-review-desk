import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';

const PROVIDERS = {
  openai: { baseUrl: 'https://api.openai.com/v1', apiFormat: 'chat' },
  anthropic: { baseUrl: 'https://api.anthropic.com/v1', apiFormat: 'messages' },
  gemini: { baseUrl: 'https://generativelanguage.googleapis.com/v1beta', apiFormat: 'generateContent' },
};
export const AI_DEFAULTS = Object.freeze({ enabled: true, provider: 'openai', ...PROVIDERS.openai, apiKey: '', model: '', timeoutMs: 120000, maxTokens: 4096, concurrency: 1, systemPrompt: '' });

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
    const saved = fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, 'utf8')) : defaults;
    this.agents = saved.agents?.length ? saved.agents.map((agent) => ({ ...merge(AI_DEFAULTS, agent), id: agent.id, name: agent.name })) : [{ ...merge(merge(AI_DEFAULTS, defaults), saved), id: 'default', name: '默认 Agent' }];
    if (!saved.agents?.length && typeof saved.apiKey === 'string') this.agents[0].apiKey = saved.apiKey;
    this.activeAgentId = saved.activeAgentId || this.agents[0].id;
    this.assignments = saved.assignments || {};
  }

  agent(id = this.activeAgentId) {
    const agent = this.agents.find((item) => item.id === id);
    if (!agent) throw new Error('找不到 Agent 配置');
    return agent;
  }
  get() { return { ...this.agent() }; }
  getFor(kind) { return { ...this.agent(this.assignments[kind] || this.activeAgentId) }; }
  publicAgent(agent) { const { apiKey, ...rest } = agent; return { ...rest, hasApiKey: !!apiKey }; }
  public() {
    return { ...this.publicAgent(this.agent()), activeAgentId: this.activeAgentId, assignments: { ...this.assignments }, agents: this.agents.map((agent) => this.publicAgent(agent)) };
  }
  forRequest(patch = {}) { return merge(this.agent(patch.agentId || this.activeAgentId), patch); }
  update(patch = {}) {
    if (patch.activeAgentId) { this.agent(patch.activeAgentId); this.activeAgentId = patch.activeAgentId; }
    if (patch.assignments) {
      for (const [kind, id] of Object.entries(patch.assignments)) {
        if (id) this.agent(id);
        this.assignments[kind] = id || '';
      }
    }
    const agent = this.agent(patch.agentId || this.activeAgentId);
    Object.assign(agent, merge(agent, patch));
    if (patch.name !== undefined) agent.name = String(patch.name);
    this.save();
    return this.public();
  }
  addAgent(patch = {}) {
    const agent = { ...merge(AI_DEFAULTS, patch), id: randomUUID(), name: patch.name || '新 Agent' };
    this.agents.push(agent);
    this.save();
    return this.publicAgent(agent);
  }
  updateAgent(id, patch) { this.agent(id); return this.update({ ...patch, agentId: id }); }
  removeAgent(id) {
    this.agent(id);
    if (this.agents.length === 1) throw new Error('请至少保留一个 Agent 配置');
    this.agents = this.agents.filter((agent) => agent.id !== id);
    if (this.activeAgentId === id) this.activeAgentId = this.agents[0].id;
    for (const kind of Object.keys(this.assignments)) if (this.assignments[kind] === id) this.assignments[kind] = '';
    this.save();
    return this.public();
  }
  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file + '.tmp', JSON.stringify({ activeAgentId: this.activeAgentId, agents: this.agents, assignments: this.assignments }, null, 2), 'utf8');
    fs.renameSync(this.file + '.tmp', this.file);
    this.emit('changed', this.public());
  }
}
