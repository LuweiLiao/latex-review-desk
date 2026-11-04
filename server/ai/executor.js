import { EventEmitter } from 'node:events';
import { generateText, redactError } from './adapters.js';
import { buildPrompt, parseResult } from './prompt.js';

const requestStamp = (item) => JSON.stringify([item.requeuedAt, item.comment, item.skill, item.anchor, item.thread, item.history]);

export class AiExecutor extends EventEmitter {
  constructor({ cfg, review, jobs, settings, fetchImpl = globalThis.fetch }) {
    super();
    Object.assign(this, { cfg, review, jobs, settings, fetchImpl });
    this.active = new Map();
    this.blocked = new Map();
    this.started = false;
    this.queued = false;
    this.lastError = '';
    this.onReview = () => { this.#cancelChanged(); this.kick(); };
    this.onSettings = () => {
      this.lastError = '';
      this.blocked.clear();
      for (const entry of this.active.values()) { entry.cancelReason = 'settings'; entry.controller.abort(); }
      this.kick();
      this.#notify();
    };
    // A server restart must not repeatedly retry requests that already failed.
    for (const item of review.items) {
      const stopped = item.ai?.state === 'error' || (item.ai?.state === 'cancelled' && item.ai.cancelReason === 'cancel');
      if (stopped && item.requeuedAt === item.ai.requeuedAt) this.blocked.set(item.id, requestStamp(item));
    }
  }

  status() {
    const config = this.settings.get();
    const configured = !!(config.model && config.apiKey && config.baseUrl);
    return {
      state: !configured ? 'unconfigured' : this.active.size ? 'busy' : this.lastError ? 'error' : 'idle',
      configured, enabled: config.enabled, busy: this.active.size,
      running: this.started, lastError: this.lastError || null,
      activeIds: [...this.active.keys()],
    };
  }

  start() {
    if (this.started) return this;
    this.started = true;
    this.review.on('pending', this.onReview);
    this.review.on('changed', this.onReview);
    this.jobs?.on('changed', this.onReview);
    this.settings.on('changed', this.onSettings);
    this.kick();
    return this;
  }

  async stop() {
    this.started = false;
    this.review.off('pending', this.onReview);
    this.review.off('changed', this.onReview);
    this.jobs?.off('changed', this.onReview);
    this.settings.off('changed', this.onSettings);
    const pending = [...this.active.values()];
    for (const entry of pending) { entry.cancelReason = 'stop'; entry.controller.abort(); }
    await Promise.allSettled(pending.map((entry) => entry.promise));
    this.#notify();
  }

  kick() {
    if (!this.started || this.queued) return;
    this.queued = true;
    queueMicrotask(() => {
      this.queued = false;
      if (!this.started) return;
      try { this.#dispatch(); }
      catch (error) { this.lastError = redactError(error, this.settings.get()); this.#notify(); }
    });
  }

  retry(id) {
    const item = this.review.find(id);
    if (item.status !== 'pending' || this.active.has(id)) throw new Error('只有待处理且未执行的请求可以重试');
    this.blocked.delete(id);
    delete item.ai;
    this.lastError = '';
    this.#save();
    this.kick();
    return this.status();
  }

  cancel(id) {
    const item = this.review.find(id);
    this.blocked.set(id, requestStamp(item));
    const entry = this.active.get(id);
    if (entry) { entry.cancelReason = 'cancel'; entry.controller.abort(); }
    else if (item.status === 'pending') {
      item.ai = { state: 'cancelled', cancelReason: 'cancel', requeuedAt: item.requeuedAt, finishedAt: Date.now() };
      this.#save();
    }
    return this.status();
  }

  #jobActive(item) {
    if (!item.job) return true;
    return this.jobs?.list?.find((job) => job.id === item.job.id)?.status === 'running';
  }

  #cancelChanged() {
    for (const [id, entry] of this.active) {
      if (entry.committing || entry.controller.signal.aborted) continue;
      const item = this.review.items.find((it) => it.id === id);
      if (!item || item.status !== 'claimed' || item.claimedAt !== entry.claimedAt || requestStamp(item) !== entry.stamp || !this.#jobActive(item)) {
        entry.cancelReason = 'changed';
        entry.controller.abort();
      }
    }
  }

  #dispatch() {
    const config = this.settings.get();
    if (!config.enabled || !this.status().configured) { this.#notify(); return; }
    const count = config.concurrency - this.active.size;
    if (count <= 0) return;
    const ids = this.review.items.filter((it) => it.status === 'pending' && !this.active.has(it.id) && this.#jobActive(it) && this.blocked.get(it.id) !== requestStamp(it))
      .sort((a, b) => a.updatedAt - b.updatedAt).slice(0, count).map((it) => it.id);
    if (!ids.length) { this.#notify(); return; }
    const payloads = this.review.claimIds(ids);
    for (const payload of payloads) {
      const item = this.review.find(payload.id);
      const entry = { controller: new AbortController(), claimedAt: item.claimedAt, stamp: requestStamp(item), committing: false };
      this.active.set(item.id, entry);
      item.ai = { state: 'running', provider: config.provider, model: config.model, requeuedAt: item.requeuedAt, startedAt: Date.now() };
      entry.promise = this.#execute(payload, entry, config).finally(() => {
        if (this.active.get(item.id) === entry) this.active.delete(item.id);
        this.#notify();
        this.kick();
      });
    }
    this.#save();
    this.#notify();
  }

  #owned(id, entry, checkStamp = true) {
    const item = this.review.items.find((it) => it.id === id);
    return item?.status === 'claimed' && item.claimedAt === entry.claimedAt && (!checkStamp || requestStamp(item) === entry.stamp) ? item : null;
  }

  async #execute(payload, entry, config) {
    try {
      const response = await generateText(config, buildPrompt(this.cfg, payload), { signal: entry.controller.signal, fetchImpl: this.fetchImpl });
      entry.controller.signal.throwIfAborted();
      const item = this.#owned(payload.id, entry);
      if (!item || !this.#jobActive(item)) return;
      const result = parseResult(response.text, payload);
      entry.committing = true;
      item.ai = { ...item.ai, state: 'done', finishedAt: Date.now(), model: response.model, usage: response.usage };
      if (result.action === 'reply') this.review.reply(item.id, result.message, result.verdict);
      else this.review.submit(item.id, result);
      this.blocked.delete(item.id);
    } catch (error) {
      const item = this.#owned(payload.id, entry, false);
      if (!item) return;
      const cancelled = entry.controller.signal.aborted;
      const message = cancelled ? '' : redactError(error, config);
      if (!cancelled) {
        this.lastError = message;
        this.blocked.set(item.id, requestStamp(item));
      }
      item.ai = { ...item.ai, state: cancelled ? 'cancelled' : 'error', cancelReason: cancelled ? entry.cancelReason : null, error: message || null, finishedAt: Date.now() };
      entry.committing = true;
      this.review.release(item.id);
    }
  }

  #save() { this.review.store.save(); this.review.emit('changed'); }
  #notify() { this.emit('changed', this.status()); }
}
