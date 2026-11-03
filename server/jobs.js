// 逐段任务：把一个范围拆成正文段（逐段润色）或独立公式（公式审核），按顺序一个一个放给 agent。
// 同一时间只放出 concurrency 段（待处理 + 处理中），agent 交了一段的方案再放下一段。
// 状态：running 进行中 / paused 已暂停 / done 已完成 / cancelled 已取消
import { EventEmitter } from 'node:events';
import { relocate } from './anchors.js';
import { splitParagraphs } from './paragraphs.js';
import { mathSegments } from '../web/lib/mathsrc.js';
import { lineStarts, offsetToLine, sectionAt } from './texfiles.js';
import { getSkill } from './skills.js';

export class Jobs extends EventEmitter {
  constructor(cfg, files, store, review) {
    super();
    this.cfg = cfg;
    this.files = files;
    this.store = store;
    this.review = review;
    store.data.jobs ??= [];
    this.busy = null;
    review.on('changed', () => this.tick());
  }

  get list() { return this.store.data.jobs; }

  find(id) {
    const j = this.list.find((x) => x.id === id);
    if (!j) throw new Error(`找不到逐段任务 ${id}`);
    return j;
  }

  // 由选区或范围算出要处理的段
  segmentsFor(file, from, to) {
    const { text } = this.files.read(file);
    const ls = lineStarts(text);
    return splitParagraphs(text, from, to).map((s) => ({
      quote: text.slice(s.start, s.end),
      line: offsetToLine(ls, s.start),
    }));
  }

  // 范围里的独立公式（行内公式放在所在段落的上下文里看，不单独审）
  formulasFor(file, from, to) {
    const { text } = this.files.read(file);
    const ls = lineStarts(text);
    return mathSegments(text)
      .filter((m) => m.kind === 'display' && m.from >= from && m.to <= to)
      .map((m) => ({ file, quote: text.slice(m.from, m.to), line: offsetToLine(ls, m.from) }));
  }

  // 全文：按 sourceDirs 里的章节顺序
  #allFormulas() {
    return this.files.list().sort(byChapter)
      .flatMap((f) => this.formulasFor(f, 0, Infinity));
  }

  async preview({ anchor, type = 'polish', whole = false }) {
    if (type === 'formula') {
      const segs = whole ? this.#allFormulas() : await this.#rangeFormulas(anchor);
      return { file: whole ? null : segs[0]?.file ?? anchor?.file, count: segs.length, files: [...new Set(segs.map((x) => x.file))].length };
    }
    const { file, from, to } = await this.#range(anchor);
    const segs = this.segmentsFor(file, from, to);
    return { file, count: segs.length, lines: segs.length ? [segs[0].line, segs.at(-1).line] : null };
  }

  async #rangeFormulas(anchor) {
    const { file, from, to } = await this.#range(anchor);
    return this.formulasFor(file, from, to);
  }

  // 公式审核任务：一个公式一条请求
  async createFormula({ anchor, whole = false, concurrency = 1, comment = '' }) {
    const skill = this.cfg.formulaSkill && getSkill(this.cfg, this.cfg.formulaSkill) ? this.cfg.formulaSkill : '';
    const segs = whole ? this.#allFormulas() : await this.#rangeFormulas(anchor);
    if (!segs.length) throw new Error('这个范围里没有独立公式');
    const first = segs[0].file;
    const { text } = this.files.read(first);
    const job = {
      id: this.store.nextId('J'),
      type: 'formula',
      file: whole ? null : first,
      // 整章用章名，选区用公式所在小节名
      label: whole ? '全文' : (anchor?.whole ? this.files.titles()[first] : sectionAt(text, text.indexOf(segs[0].quote))) || first,
      skill,
      comment: comment.trim(),
      concurrency: Math.min(3, Math.max(1, Number(concurrency) || 1)),
      status: 'running',
      segments: segs.map((x) => ({ ...x, itemId: null, skipped: false })),
      next: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.list.push(job);
    this.#save();
    await this.tick();
    return this.view(job);
  }

  async create({ anchor, skill, comment = '', concurrency = 1, label = '' }) {
    skill ||= this.cfg.defaultSkill;
    if (!getSkill(this.cfg, skill)) throw new Error(`没有找到 skill：${skill}`);
    const { file, from, to } = await this.#range(anchor);
    const segs = this.segmentsFor(file, from, to);
    if (!segs.length) throw new Error('这个范围里没有可润色的正文段（公式、图表、标题会自动跳过）');
    const { text } = this.files.read(file);
    const job = {
      id: this.store.nextId('J'),
      file,
      label: label || sectionAt(text, from) || file,
      skill,
      comment: comment.trim(),
      concurrency: Math.min(3, Math.max(1, Number(concurrency) || 1)),
      status: 'running',
      segments: segs.map((s) => ({ ...s, itemId: null, skipped: false })),
      next: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.list.push(job);
    this.#save();
    await this.tick();
    return this.view(job);
  }

  async #range(anchor = {}) {
    if (anchor.source === 'source' && anchor.whole) {
      const file = this.files.resolve(anchor.file).rel;
      return { file, from: 0, to: this.files.read(file).text.length };
    }
    // 其余情况复用批注的定位逻辑（PDF 选区会先对回源码）
    const a = await this.review.resolveAnchor(anchor);
    const { text } = this.files.read(a.file);
    const loc = relocate(text, a.quote, a.lineStart);
    return { file: a.file, from: loc.start, to: loc.end };
  }

  // 放出下一段；串行执行，避免并发重入
  tick() {
    if (this.busy) { this.again = true; return this.busy; }
    this.busy = (async () => {
      do {
        this.again = false;
        for (const job of this.list) if (job.status === 'running') await this.#fill(job);
      } while (this.again);
    })().finally(() => { this.busy = null; });
    return this.busy;
  }

  async #fill(job) {
    const items = new Map(this.review.items.map((it) => [it.id, it]));
    const inflight = () => job.segments.filter((s) => s.itemId && ['pending', 'claimed'].includes(items.get(s.itemId)?.status)).length;
    let changed = false;
    while (job.next < job.segments.length && inflight() < job.concurrency) {
      const seg = job.segments[job.next];
      const idx = job.next++;
      changed = true;
      const file = seg.file || job.file;
      const kind = job.type === 'formula' ? 'formula' : 'polish';
      const { text } = this.files.read(file);
      const loc = relocate(text, seg.quote, seg.line);
      if (!loc) { seg.skipped = true; continue; } // 这段在任务开始后被改掉了
      const existing = this.#openOverlapping(file, text, loc, kind);
      if (existing) { seg.itemId = existing.id; seg.adopted = true; continue; }
      try {
        const it = await this.review.create({
          kind,
          skill: job.skill,
          comment: job.comment,
          anchor: { source: 'source', file, from: loc.start, to: loc.end, quote: seg.quote },
          job: { id: job.id, index: idx + 1, total: job.segments.length, label: job.label, type: job.type || 'polish' },
        });
        seg.itemId = it.id;
        items.set(it.id, this.review.find(it.id));
      } catch {
        seg.skipped = true;
      }
    }
    if (job.next >= job.segments.length && inflight() === 0 && job.status === 'running') { job.status = 'done'; changed = true; }
    if (changed) { job.updatedAt = Date.now(); this.#save(); }
  }

  // 同一文件里与 [loc.start, loc.end) 重叠的未完成请求
  // 只看同类请求：公式审核和润色互不顶替
  #openOverlapping(file, text, loc, kind = 'polish') {
    for (const it of this.review.items) {
      if (it.anchor.file !== file || !['pending', 'claimed', 'proposed', 'replied'].includes(it.status)) continue;
      if ((it.kind === 'formula') !== (kind === 'formula')) continue;
      const r = relocate(text, it.anchor.quote, it.anchor.lineStart);
      if (r && r.start < loc.end && loc.start < r.end) return it;
    }
    return null;
  }

  pause(id) { const j = this.find(id); if (j.status === 'running') j.status = 'paused'; this.#save(); return this.view(j); }

  resume(id) {
    const j = this.find(id);
    if (j.status === 'paused') j.status = 'running';
    this.#save();
    this.tick();
    return this.view(j);
  }

  // 取消：还没被领取的段撤回，已在处理的让它做完
  cancel(id) {
    const j = this.find(id);
    j.status = 'cancelled';
    for (const s of j.segments) {
      if (!s.itemId) continue;
      const it = this.review.items.find((x) => x.id === s.itemId);
      if (it?.status === 'pending') { this.review.remove(it.id); s.itemId = null; s.skipped = true; }
    }
    this.#save();
    return this.view(j);
  }

  remove(id) {
    const i = this.list.findIndex((x) => x.id === id);
    if (i === -1) throw new Error(`找不到逐段任务 ${id}`);
    if (['running', 'paused'].includes(this.list[i].status)) throw new Error('任务还在进行，请先取消');
    this.list.splice(i, 1);
    this.#save();
  }

  view(job) {
    const counts = { queued: 0, pending: 0, claimed: 0, proposed: 0, replied: 0, accepted: 0, rejected: 0, skipped: 0 };
    for (const s of job.segments) {
      if (s.skipped) counts.skipped++;
      else if (!s.itemId) counts[job.status === 'cancelled' ? 'skipped' : 'queued']++;
      else {
        const st = this.review.items.find((x) => x.id === s.itemId)?.status;
        if (st) counts[st] = (counts[st] || 0) + 1;
      }
    }
    if (job.type === 'formula') {
      Object.assign(counts, { pass: 0, issue: 0, unsure: 0 });
      for (const s of job.segments) {
        const it = s.itemId && this.review.items.find((x) => x.id === s.itemId);
        if (it?.verdict) counts[it.verdict]++;
      }
    }
    const { segments, ...rest } = job;
    return { ...rest, total: segments.length, counts };
  }

  views() { return this.list.map((j) => this.view(j)); }

  #save() {
    this.store.save();
    this.emit('changed');
  }
}

// chapter2_x.tex 排在 chapter10 前面：按文件名里的第一个数字
function byChapter(a, b) {
  const n = (f) => Number(/(\d+)/.exec(f.replace(/^.*\//, ''))?.[1] ?? 999);
  return n(a) - n(b) || a.localeCompare(b);
}
