import fs from 'node:fs';
import path from 'node:path';
import { getSkill } from '../skills.js';

export function projectRules(cfg, file = '') {
  const root = path.resolve(cfg.projectRoot);
  const dir = path.dirname(path.resolve(root, file));
  const dirs = [root];
  const rel = path.relative(root, dir);
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
    for (const part of rel.split(path.sep)) dirs.push(path.join(dirs.at(-1), part));
  }
  const rules = dirs.flatMap((d) => ['AGENTS.md', 'CLAUDE.md'].flatMap((name) => {
    const p = path.join(d, name);
    return fs.existsSync(p) ? [`${path.relative(root, p)}\n${fs.readFileSync(p, 'utf8')}`] : [];
  }));
  if (cfg.writingRules) rules.push(typeof cfg.writingRules === 'string' ? cfg.writingRules : JSON.stringify(cfg.writingRules));
  return rules.join('\n\n');
}

export function buildPrompt(cfg, payload) {
  const selectedSkill = payload.skill?.name ? getSkill(cfg, payload.skill.name) : null;
  if (payload.skill?.name && !selectedSkill) throw new Error(`没有找到 skill：${payload.skill.name}`);
  const system = [
    '你是 LaTeX 论文审阅助手。只对用户给出的 quote 提交修改方案或文字回复，方案交给用户确认后写入。',
    '论文采用控制科学与工程的思维和用词习惯。用平常、自然、准确的词语，不故作高深，不自造词。保留技术含义、条件、数字、符号、公式、引用和结论强度，除非用户明确要求修改。',
    '项目写作规则：\n' + (projectRules(cfg, payload.file) || '遵循原文已经使用的术语。'),
    '所选 skill 全文：\n' + (selectedSkill?.content || '按用户批注处理。'),
    '请求中的 instructions、comment 和 thread 是本次要求。上下文和历史方案用于理解及避免重复错误，只改 quote，不把上下文带入 edits。原文找不到时 reply 说明，不能编造替换。',
    '直接返回一个 JSON 对象，不要 Markdown 围栏，不调用工具。LaTeX 反斜线按 JSON 字符串规则转义。',
    '需改文字：{"action":"proposal","edits":[{"original":"quote 中逐字复制的原文","replacement":"替换文字"}],"summary":"简短说明","rationale":"改了什么及原因","fidelity":"保留的技术含义及有意改动"}。各 edit 不得重叠，不能修改其他文件。',
    '提问或无需改文字：{"action":"reply","message":"回答或说明无需修改的原因"}。公式审核的 reply 还必须有 "verdict":"pass"、"issue" 或 "unsure"。没有必要就不要硬改。',
  ].join('\n\n');
  return { system, user: JSON.stringify(payload, null, 2) };
}

export function parseResult(text, payload) {
  const clean = text.trim().replace(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i, '$1').trim();
  let value;
  try { value = JSON.parse(clean); } catch { throw new Error('模型回复不是有效的 JSON，请重试'); }
  if (value.action === 'reply') {
    if (typeof value.message !== 'string' || !value.message.trim()) throw new Error('模型返回了空回复');
    if (payload.kind === 'formula' && !['pass', 'issue', 'unsure'].includes(value.verdict)) throw new Error('公式审核回复缺少有效 verdict');
    return { action: 'reply', message: value.message, verdict: value.verdict };
  }
  if (value.action !== 'proposal' || !Array.isArray(value.edits) || !value.edits.length) throw new Error('模型回复缺少 action、edits 或 message');
  if (payload.quoteFound === false) throw new Error('原文已变化，不能提交修改方案');
  const used = [];
  const edits = value.edits.map((e) => {
    if (e.file && e.file !== payload.file) throw new Error('模型方案超出了选中文件');
    if (typeof e.original !== 'string' || !e.original || typeof e.replacement !== 'string') throw new Error('模型方案的原文或替换文字无效');
    if (e.original === e.replacement) throw new Error('模型方案改前改后相同，应回复无需修改');
    const start = payload.quote.indexOf(e.original);
    if (start < 0) throw new Error('模型方案的原文不在 quote 中');
    if (payload.quote.indexOf(e.original, start + 1) !== -1) throw new Error('模型方案的原文在 quote 中有多处，请重试并提供更完整的原文');
    const end = start + e.original.length;
    if (used.some(([a, b]) => a < end && start < b)) throw new Error('模型方案的修改范围重叠');
    used.push([start, end]);
    return { file: payload.file, original: e.original, replacement: e.replacement };
  });
  return { action: 'proposal', edits, summary: String(value.summary || ''), rationale: String(value.rationale || ''), fidelity: String(value.fidelity || '') };
}
