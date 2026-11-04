// MCP 服务（Streamable HTTP，挂在 /mcp）。每个 MCP 会话一个 McpServer，共用同一个 Review 状态。
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { getSkill, listSkills } from './skills.js';

const text = (obj) => ({ content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2) }] });
const fail = (e) => ({ isError: true, content: [{ type: 'text', text: String(e?.message || e) }] });

function buildServer(cfg, review) {
  const server = new McpServer({ name: 'thesis-review', version: '0.1.0' });

  server.registerTool('wait_for_requests', {
    title: '等待网页上的批注/润色请求',
    description:
      '阻塞等待用户在论文审阅网页上提交的批注或润色请求，领取后返回（状态变为“处理中”）。' +
      '超时没有新请求时返回空列表，此时再调用一次继续等。每条请求处理完必须调用 submit_proposal 或 reply。' +
      '默认只领批注和润色；公式审核 agent 传 kinds=["formula"]，只领公式审核请求。',
    inputSchema: {
      kinds: z.array(z.enum(['comment', 'polish', 'formula'])).min(1).optional().describe('领取哪些类型，默认 ["comment","polish"]'),
      max: z.number().int().min(1).max(10).optional().describe('一次最多领取几条，默认 3'),
      timeout_sec: z.number().int().min(5).max(1800).optional().describe(`最长等待秒数，默认 ${cfg.waitTimeoutSec}`),
    },
  }, async ({ max = 3, timeout_sec, kinds }, extra) => {
    const token = extra?._meta?.progressToken;
    let n = 0;
    const onTick = token == null ? null : () => {
      extra.sendNotification({ method: 'notifications/progress', params: { progressToken: token, progress: ++n, message: '等待网页请求' } }).catch(() => {});
    };
    const got = await review.wait({ max, kinds, timeoutMs: (timeout_sec ?? cfg.waitTimeoutSec) * 1000, signal: extra?.signal, onTick });
    if (!got.length) return text({ requests: [], note: '暂时没有新请求，请再次调用 wait_for_requests' });
    return text({ requests: got, projectRoot: cfg.projectRoot.replace(/\\/g, '/') });
  });

  server.registerTool('list_requests', {
    title: '列出请求',
    description: '按状态列出请求（pending 待处理 / claimed 处理中 / proposed 待用户确认 / replied / accepted / rejected）。',
    inputSchema: { status: z.string().optional() },
  }, async ({ status }) => {
    const rows = review.list().filter((x) => !status || x.status === status)
      .map((x) => ({ id: x.id, kind: x.kind, status: x.status, file: x.anchor.file, line: x.anchor.lineStart, comment: x.comment.slice(0, 80), skill: x.skill, stale: x.stale }));
    return text(rows);
  });

  server.registerTool('get_request', {
    title: '查看一条请求的完整内容',
    description: '返回请求的选中原文、上下文、对话记录和之前被驳回的方案。',
    inputSchema: { id: z.string() },
  }, async ({ id }) => {
    try { return text(review.payload(review.find(id))); } catch (e) { return fail(e); }
  });

  server.registerTool('submit_proposal', {
    title: '提交修改方案（不会直接写入论文）',
    description:
      '为一条请求提交修改方案，网页上会以“修改前/修改后”对照显示，由用户决定是否写入。' +
      'edits[].original 必须是源码里逐字存在的片段（含 LaTeX 命令、空格和换行），若出现多次需带足上下文使其唯一；' +
      'replacement 是替换后的源码。服务端会校验，找不到时返回错误，请重新读取文件后修正。',
    inputSchema: {
      id: z.string(),
      edits: z.array(z.object({
        file: z.string().optional().describe('相对论文根目录的路径，省略则用请求所在文件'),
        original: z.string(),
        replacement: z.string(),
      })).min(1),
      rationale: z.string().describe('理由与收益：改了什么、为什么这样改'),
      fidelity: z.string().describe('保真复核：数字、符号、术语、引用、结论边界是否保持不变'),
      summary: z.string().optional().describe('一句话概括，显示在批注列表里'),
    },
  }, async (args) => {
    try { return text(review.submit(args.id, args)); } catch (e) { return fail(e); }
  });

  server.registerTool('reply', {
    title: '回复一条请求（不改文字）',
    description: '批注是提问、或判断不需要修改时，用文字回复用户。公式审核请求必须带 verdict：pass 通过 / issue 有问题 / unsure 拿不准。',
    inputSchema: {
      id: z.string(),
      message: z.string(),
      verdict: z.enum(['pass', 'issue', 'unsure']).optional().describe('公式审核的结论（只对 kind=formula 的请求有效且必填）'),
    },
  }, async ({ id, message, verdict }) => {
    try { return text(review.reply(id, message, verdict)); } catch (e) { return fail(e); }
  });

  server.registerTool('get_skill', {
    title: '读取 skill 说明',
    description: '返回指定 skill 的 SKILL.md 全文和所在目录（其中引用的 references/ 文件可用 Read 读取）。不传 name 时列出全部。',
    inputSchema: { name: z.string().optional() },
  }, async ({ name }) => {
    if (!name) return text(listSkills(cfg).map(({ name, description }) => ({ name, description: description.slice(0, 120) })));
    const s = getSkill(cfg, name);
    return s ? text(`# ${s.path}\n\n${s.content}`) : fail(`没有 skill：${name}`);
  });

  return server;
}

export function mountMcp(app, cfg, review) {
  const sessions = new Map();

  app.post('/mcp', async (req, res) => {
    const sid = req.headers['mcp-session-id'];
    let transport = sid ? sessions.get(sid) : null;
    if (!transport) {
      if (sid || !isInitializeRequest(req.body)) {
        return res.status(sid ? 404 : 400).json({ jsonrpc: '2.0', error: { code: -32000, message: sid ? '会话不存在，请重新连接' : '缺少会话' }, id: null });
      }
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => sessions.set(id, transport),
      });
      transport.onclose = () => { if (transport.sessionId) sessions.delete(transport.sessionId); };
      await buildServer(cfg, review).connect(transport);
    }
    await transport.handleRequest(req, res, req.body);
  });

  const bySession = async (req, res) => {
    const t = sessions.get(req.headers['mcp-session-id']);
    if (!t) return res.status(404).send('会话不存在');
    await t.handleRequest(req, res);
  };
  app.get('/mcp', bySession);
  app.delete('/mcp', bySession);
}
