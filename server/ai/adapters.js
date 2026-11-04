// Direct HTTP adapters. Keep native request/response formats separate from review logic.
// Official references: developers.openai.com/api/reference/resources/{responses,chat};
// platform.claude.com/docs/en/api/messages/create; ai.google.dev/api/generate-content.
function endpoint(config, suffix) {
  const base = config.baseUrl.replace(/\/+$/, '');
  if (base.endsWith(suffix)) return base;
  return base + suffix;
}

function requestFor(config, prompt) {
  const headers = { 'content-type': 'application/json' };
  const common = { model: config.model, stream: false };
  if (config.provider === 'openai') {
    if (config.apiKey) headers.authorization = `Bearer ${config.apiKey}`;
    if (config.apiFormat === 'responses') return {
      url: endpoint(config, '/responses'), headers,
      body: { ...common, instructions: prompt.system, input: [{ role: 'user', content: prompt.user }], max_output_tokens: config.maxTokens, store: false },
    };
    return {
      url: endpoint(config, '/chat/completions'), headers,
      body: { ...common, messages: [{ role: 'system', content: prompt.system }, { role: 'user', content: prompt.user }], max_completion_tokens: config.maxTokens },
    };
  }
  if (config.provider === 'anthropic') {
    if (config.apiKey) headers['x-api-key'] = config.apiKey;
    headers['anthropic-version'] = '2026-10-21';
    return {
      url: endpoint(config, '/messages'), headers,
      body: { ...common, system: prompt.system, messages: [{ role: 'user', content: prompt.user }], max_tokens: config.maxTokens },
    };
  }
  if (config.provider === 'gemini') {
    if (config.apiKey) headers['x-goog-api-key'] = config.apiKey;
    const model = config.model.replace(/^models\//, '');
    return {
      url: endpoint(config, `/models/${encodeURIComponent(model)}:generateContent`), headers,
      body: { systemInstruction: { parts: [{ text: prompt.system }] }, contents: [{ role: 'user', parts: [{ text: prompt.user }] }], generationConfig: { maxOutputTokens: config.maxTokens } },
    };
  }
  throw new Error('不支持的 AI 服务商');
}

function textOf(config, data) {
  let text;
  if (config.provider === 'openai' && config.apiFormat === 'responses') {
    if (data.status === 'incomplete' || data.status === 'failed' || data.error) throw new Error(`模型未完成回复：${data.error?.message || data.incomplete_details?.reason || data.status}`);
    text = data.output?.filter((x) => x.type === 'message').flatMap((x) => x.content || []).filter((x) => x.type === 'output_text').map((x) => x.text).join('') || data.output_text;
  } else if (config.provider === 'openai') {
    const choice = data.choices?.[0];
    if (choice?.finish_reason && choice.finish_reason !== 'stop') throw new Error(`模型未完成回复：${choice.finish_reason}`);
    const content = choice?.message?.content;
    text = typeof content === 'string' ? content : content?.filter((x) => x.type === 'text').map((x) => x.text).join('');
  } else if (config.provider === 'anthropic') {
    if (data.stop_reason && !['end_turn', 'stop_sequence'].includes(data.stop_reason)) throw new Error(`模型未完成回复：${data.stop_reason}`);
    text = data.content?.filter((x) => x.type === 'text').map((x) => x.text).join('');
  } else {
    const candidate = data.candidates?.[0];
    if (candidate?.finishReason && candidate.finishReason !== 'STOP') throw new Error(`模型未完成回复：${candidate.finishReason}`);
    text = candidate?.content?.parts?.filter((x) => !x.thought && typeof x.text === 'string').map((x) => x.text).join('');
  }
  if (!text?.trim()) throw new Error('模型没有返回文本');
  return text;
}

export function redactError(error, config = {}) {
  let message = error?.message || String(error);
  if (config.apiKey) message = message.split(config.apiKey).join('[已隐藏密钥]');
  return message;
}

export async function generateText(config, prompt, { signal, fetchImpl = globalThis.fetch } = {}) {
  if (!config.model?.trim()) throw new Error('请先填写模型名称');
  const req = requestFor(config, prompt);
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(() => controller.abort(new DOMException('AI 请求超时', 'TimeoutError')), config.timeoutMs || 120000);
  try {
    const response = await fetchImpl(req.url, { method: 'POST', headers: req.headers, body: JSON.stringify(req.body), signal: controller.signal });
    const raw = await response.text();
    controller.signal.throwIfAborted();
    let data;
    try { data = JSON.parse(raw); } catch { throw new Error(`AI 服务返回了非 JSON 内容（HTTP ${response.status}）`); }
    if (!response.ok || data.error) throw new Error(`AI 服务请求失败（HTTP ${response.status}）：${data.error?.message || data.error?.status || response.statusText}`);
    return { text: textOf(config, data), model: data.model || data.modelVersion || config.model, usage: data.usage || data.usageMetadata || null };
  } catch (error) {
    if (controller.signal.aborted) throw controller.signal.reason;
    throw new Error(redactError(error, config));
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
  }
}

export async function testConnection(config, options = {}) {
  const start = Date.now();
  const result = await generateText(config, { system: 'Reply briefly to confirm this connection.', user: 'Reply OK.' }, options);
  return { ok: true, model: result.model, latencyMs: Date.now() - start };
}
