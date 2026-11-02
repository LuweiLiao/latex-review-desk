// 用 MCP 客户端模拟后台 agent：领取一条请求并提交修改方案（不写入论文）。
// 用法：node scripts/mcp-smoke.js [超时秒数]
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const url = new URL(process.env.MCP_URL || 'http://127.0.0.1:4317/mcp');
const client = new Client({ name: 'mcp-smoke', version: '0.0.1' });
await client.connect(new StreamableHTTPClientTransport(url));

const tools = await client.listTools();
console.log('工具：', tools.tools.map((t) => t.name).join(', '));

const res = await client.callTool({ name: 'wait_for_requests', arguments: { max: 1, timeout_sec: Number(process.argv[2] || 10) } });
const data = JSON.parse(res.content[0].text);
if (!data.requests.length) { console.log('没有请求'); process.exit(0); }
const r = data.requests[0];
console.log('领到：', r.id, r.kind, r.file, r.lineStart, JSON.stringify(r.quote));
console.log(r.context.split('\n').slice(13, 18).join('\n'));

// 故意先交一个错的原文，确认服务端会拒绝
const bad = await client.callTool({ name: 'submit_proposal', arguments: { id: r.id, edits: [{ original: r.quote + '不存在', replacement: 'x' }], rationale: '', fidelity: '' } });
console.log('错误原文被拒：', bad.isError, bad.content[0].text.slice(0, 40));

const ok = await client.callTool({
  name: 'submit_proposal',
  arguments: {
    id: r.id,
    edits: [{ original: r.quote, replacement: r.quote.replace('科氏与离心项', '科里奥利项与离心项') }],
    rationale: '（冒烟测试）补全“科氏”为“科里奥利项”，与前文术语一致。',
    fidelity: '未改动符号、公式与结论。',
    summary: '科氏 → 科里奥利项',
  },
});
console.log('提交：', ok.content[0].text);
await client.close();
