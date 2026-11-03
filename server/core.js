// 请求（批注 / 润色）的状态机，修改方案的校验、写入和撤销。
// 状态：pending 待处理 → claimed 处理中 → proposed 待确认 / replied 已回复 → accepted / rejected
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { locatePdfSelection, matchInRange, relocate } from './anchors.js';
import { backward, forward } from './synctex.js';
import { findAll, lineStarts, lineToOffset, nearest, offsetToLine, paragraphRange, sectionAt } from './texfiles.js';
import { getSkill } from './skills.js';

const OPEN = new Set(['pending', 'claimed', 'proposed', 'replied']);
export const KINDS = ['comment', 'polish', 'formula'];
// 两类后台 agent：review 处理批注和润色，formula 只做公式审核
const ROLE_KINDS = { review: ['comment', 'polish'], formula: ['formula'] };
const roleOf = (kinds) => (kinds?.length === 1 && kinds[0] === 'formula' ? 'formula' : 'review');

export class Review extends EventEmitter {
  constructor(cfg, files, store) {
    super();
    this.setMaxListeners(100);
    this.cfg = cfg;
    this.files = files;
    this.store = store;
    this.agents = { review: { lastSeen: 0, waiting: 0 }, formula: { lastSeen: 0, waiting: 0 } };
    this.timer = setInterval(() => this.releaseExpired(), 60_000);
    this.timer.unref();
  }

  get items() { return this.store.data.items; }

  find(id) {
    const it = this.items.find((x) => x.id === id);
    if (!it) throw new Error(`找不到请求 ${id}`);
    return it;
  }

  #changed(pending = false) {
    this.store.save();
    this.emit('changed');
    if (pending) this.emit('pending');
  }

  // ---- 给网页看的视图：实时判断“原文已改”和方案冲突 ----

  view(item) {
    const v = { ...item, stale: false, conflict: false };
    if (!OPEN.has(item.status)) return v;
    try {
      const { text } = this.files.read(item.anchor.file);
      const loc = relocate(text, item.anchor.quote, item.anchor.lineStart);
      if (loc) v.anchor = { ...item.anchor, lineStart: loc.lineStart, lineEnd: loc.lineEnd };
      else v.stale = true;
      if (item.status === 'proposed' && item.proposal)
        v.conflict = item.proposal.edits.some((e) => !this.files.read(e.file).text.includes(e.original));
    } catch {
      v.stale = true;
    }
    return v;
  }

  list() { return this.items.map((it) => this.view(it)); }

  // ---- 新建请求 ----

  async create({ kind, comment = '', skill = '', anchor, job = null }) {
    if (!KINDS.includes(kind)) throw new Error('kind 只能是 comment、polish 或 formula');
    if (kind === 'polish' && !skill) skill = this.cfg.defaultSkill;
    if (kind === 'formula' && !skill && this.cfg.formulaSkill && getSkill(this.cfg, this.cfg.formulaSkill)) skill = this.cfg.formulaSkill;
    if (kind === 'comment' && !comment.trim()) throw new Error('批注内容不能为空');
    if (skill && !getSkill(this.cfg, skill)) throw new Error(`没有找到 skill：${skill}`);
    const a = await this.resolveAnchor(anchor || {});
    const item = {
      id: this.store.nextId('R'),
      kind,
      comment: comment.trim(),
      skill: skill || '',
      anchor: a,
      status: 'pending',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      thread: [],
      proposal: null,
      history: [],
      job: job ? { id: job.id, index: job.index, total: job.total, label: job.label } : null,
    };
    this.items.push(item);
    this.#changed(true);
    return this.view(item);
  }

  async resolveAnchor(anchor) {
    let file, start, end, approximate = false;
    if (anchor.source === 'source' && anchor.whole) {
      file = this.files.resolve(anchor.file).rel;
      start = 0;
      end = this.files.read(file).text.length;
    } else if (anchor.source === 'source') {
      file = this.files.resolve(anchor.file).rel;
      const { text } = this.files.read(file);
      start = anchor.from; end = anchor.to;
      if (!(start >= 0 && end > start && end <= text.length) || (anchor.quote && text.slice(start, end) !== anchor.quote)) {
        const occ = findAll(text, anchor.quote || '');
        if (!occ.length) throw new Error('源码已经变化，请重新选择');
        start = nearest(occ, anchor.from || 0);
        end = start + anchor.quote.length;
      }
    } else if (anchor.source === 'pdf') {
      const pdfText = String(anchor.text || '').trim();
      if (!pdfText) throw new Error('没有选中文字');
      let hint = null;
      if (anchor.point) hint = await backward(this.cfg, anchor.page, anchor.point.x, anchor.point.y).catch(() => null);
      let r = null;
      if (hint && this.#allowed(hint.file)) {
        file = this.files.resolve(hint.file).rel;
        r = locatePdfSelection(this.files.read(file).text, pdfText, hint.line);
        if (r && !r.exact) approximate = true;
      }
      if (!r) {
        for (const f of this.files.list()) {
          const t = this.files.read(f).text;
          const m = matchInRange(t, pdfText, 0, t.length);
          if (m?.exact) { file = f; r = m; break; }
        }
      }
      if (!r && file) {
        // 实在对不上就整行引用，标为近似
        const { text } = this.files.read(file);
        const ls = lineStarts(text);
        start = lineToOffset(ls, hint.line);
        end = text.indexOf('\n', start);
        if (end === -1) end = text.length;
        approximate = true;
      } else if (r) {
        ({ start, end } = r);
      } else {
        throw new Error('没能在源码里找到这段文字，请改在左侧源码里选择');
      }
    } else {
      throw new Error('anchor.source 只能是 source 或 pdf');
    }

    const { text } = this.files.read(file);
    const quote = text.slice(start, end);
    if (!quote.trim()) throw new Error('选中的源码是空白');
    if (quote.length > 60000) throw new Error(`范围有 ${quote.length} 字，一次交给 agent 改不现实，请勾选“逐段润色”`);
    const ls = lineStarts(text);
    const lineStart = offsetToLine(ls, start);
    let page = anchor.page || null;
    if (!page) page = (await forward(this.cfg, file, lineStart).catch(() => []))[0]?.page || null;
    return {
      file,
      quote,
      lineStart,
      lineEnd: offsetToLine(ls, end),
      section: sectionAt(text, start),
      page,
      pdfText: anchor.source === 'pdf' ? String(anchor.text).trim() : '',
      rects: Array.isArray(anchor.rects) ? anchor.rects.slice(0, 50) : null,
      approximate,
    };
  }

  #allowed(rel) {
    try { this.files.resolve(rel); return true; } catch { return false; }
  }

  update(id, { comment, skill }) {
    const it = this.find(id);
    if (comment !== undefined) it.comment = String(comment);
    if (skill !== undefined) it.skill = String(skill);
    it.updatedAt = Date.now();
    this.#changed();
    return this.view(it);
  }

  remove(id) {
    const i = this.items.findIndex((x) => x.id === id);
    if (i === -1) throw new Error(`找不到请求 ${id}`);
    this.items.splice(i, 1);
    this.#changed();
  }

  // 用户追加意见、要求重做
  requeue(id, message = '', skill) {
    const it = this.find(id);
    if (it.status === 'accepted') throw new Error('已接受的修改请先撤销');
    if (skill && skill !== it.skill) {
      if (!getSkill(this.cfg, skill)) throw new Error(`没有找到 skill：${skill}`);
      it.thread.push({ role: 'user', text: `改用 skill：${skill}`, at: Date.now() });
      it.skill = skill;
      if (it.kind === 'comment') it.kind = 'polish';
    }
    it.requeuedAt = Date.now();
    delete it.verdict;
    if (message.trim()) it.thread.push({ role: 'user', text: message.trim(), at: it.requeuedAt });
    if (it.proposal) {
      it.history.push({ proposal: it.proposal, verdict: 'redo', feedback: message.trim(), at: Date.now() });
      it.proposal = null;
    }
    it.status = 'pending';
    it.updatedAt = Date.now();
    this.#changed(true);
    return this.view(it);
  }

  // ---- agent 侧 ----

  claim(max = 3, kinds = ROLE_KINDS.review) {
    const picked = this.items
      .filter((x) => x.status === 'pending' && kinds.includes(x.kind))
      .sort((a, b) => a.updatedAt - b.updatedAt)
      .slice(0, max);
    for (const it of picked) { it.status = 'claimed'; it.claimedAt = Date.now(); it.updatedAt = Date.now(); }
    if (picked.length) this.#changed();
    return picked.map((it) => this.payload(it));
  }

  payload(it) {
    const { text } = this.files.read(it.anchor.file);
    const loc = relocate(text, it.anchor.quote, it.anchor.lineStart);
    const lines = text.split('\n');
    const ls0 = loc?.lineStart ?? it.anchor.lineStart;
    const le0 = loc?.lineEnd ?? it.anchor.lineEnd;
    // 公式审核要看推导从哪来，往前多给些
    const before = it.kind === 'formula' ? 40 : 15;
    const from = Math.max(1, ls0 - before), to = Math.min(lines.length, le0 + 15);
    const context = lines.slice(from - 1, to).map((l, i) => `${String(from + i).padStart(5)}| ${l}`).join('\n');
    let paragraph = '';
    if (loc) { const [ps, pe] = paragraphRange(text, loc.start, loc.end); paragraph = text.slice(ps, pe); }
    const skill = it.skill ? getSkill(this.cfg, it.skill) : null;
    return {
      id: it.id,
      kind: it.kind,
      comment: it.comment,
      skill: skill ? { name: skill.name, path: skill.path, description: skill.description } : null,
      job: it.job,
      instructions: it.kind === 'formula' ? formulaInstructions(it, skill) : (it.job ? `这是逐段润色任务 ${it.job.id}（${it.job.label}）的第 ${it.job.index}/${it.job.total} 段：只改 quote 这一段，不要改动或合并前后段落；前后段会作为单独的请求陆续发来。这一段已经写得好、按 skill 规则没有要改的，就用 reply 说明“无需修改”，不要硬改。` : '') + (skill
        ? `用户指定用 skill「${skill.name}」处理：先调用 get_skill("${skill.name}") 读取全文，严格按它的规则改写 quote；comment 是附加要求，优先于 skill 默认做法。rationale 里写明按该 skill 的哪些规则改了什么。`
        : '批注请求：判断是要求修改还是提问，修改就 submit_proposal，提问或无需修改就 reply。'),
      file: it.anchor.file,
      absPath: path.join(this.cfg.projectRoot, it.anchor.file).replace(/\\/g, '/'),
      lineStart: ls0,
      lineEnd: le0,
      section: it.anchor.section,
      page: it.anchor.page,
      quote: it.anchor.quote,
      quoteFound: !!loc,
      approximate: it.anchor.approximate,
      paragraph,
      context,
      thread: it.thread,
      ...(it.kind === 'formula' ? { formula: it.formula || null } : {}),
      previousProposals: it.history.map((h) => ({
        verdict: h.verdict,
        feedback: h.feedback || h.reason || '',
        edits: h.proposal.edits.map(({ original, replacement }) => ({ original, replacement })),
      })),
    };
  }

  async wait({ max = 3, timeoutMs = 240_000, signal, onTick, kinds = ROLE_KINDS.review } = {}) {
    const role = roleOf(kinds);
    this.agents[role].waiting++;
    this.#touch(role);
    const deadline = Date.now() + timeoutMs;
    try {
      while (true) {
        const got = this.claim(max, kinds);
        if (got.length) return got;
        const left = deadline - Date.now();
        if (left <= 0 || signal?.aborted) return [];
        await new Promise((resolve) => {
          const done = () => { clearTimeout(t); clearInterval(tick); this.off('pending', done); signal?.removeEventListener('abort', done); resolve(); };
          const t = setTimeout(done, left);
          const tick = setInterval(() => { this.#touch(role); onTick?.(); }, 20_000);
          this.on('pending', done);
          signal?.addEventListener('abort', done);
        });
      }
    } finally {
      this.agents[role].waiting--;
      this.#touch(role);
    }
  }

  #touch(role = 'review') {
    this.agents[role].lastSeen = Date.now();
    this.emit('agent', this.agentStatus());
  }

  #roleStatus(role) {
    const a = this.agents[role];
    const age = Date.now() - a.lastSeen;
    const busy = this.items.filter((x) => x.status === 'claimed' && ROLE_KINDS[role].includes(x.kind)).length;
    let state = 'offline';
    if (a.waiting > 0) state = 'waiting';
    else if (age < 10 * 60_000 && (busy || age < 90_000)) state = 'busy';
    return { state, lastSeen: a.lastSeen, busy };
  }

  // 顶层字段是批注 / 润色 agent（兼容旧网页），formula 是公式审核 agent
  agentStatus() {
    return { ...this.#roleStatus('review'), formula: this.#roleStatus('formula') };
  }

  submit(id, { edits, rationale = '', fidelity = '', summary = '', verdict }) {
    const it = this.find(id);
    this.#touch(it.kind === 'formula' ? 'formula' : 'review');
    if (!OPEN.has(it.status)) throw new Error(`${id} 当前状态是 ${it.status}，不能再提交方案`);
    if (!Array.isArray(edits) || !edits.length) throw new Error('edits 不能为空；不需要改文字时请用 reply');
    const anchorText = this.files.read(it.anchor.file).text;
    const anchorLoc = relocate(anchorText, it.anchor.quote, it.anchor.lineStart);
    const resolved = edits.map((e, i) => {
      const file = this.files.resolve(e.file || it.anchor.file).rel;
      const original = String(e.original ?? '').replace(/\r\n/g, '\n');
      const replacement = String(e.replacement ?? '').replace(/\r\n/g, '\n');
      if (!original) throw new Error(`edits[${i}].original 为空`);
      if (original === replacement) throw new Error(`edits[${i}] 改前改后相同`);
      const text = this.files.read(file).text;
      const occ = findAll(text, original);
      if (!occ.length) throw new Error(`edits[${i}].original 在 ${file} 里找不到。必须和源码逐字一致（含空格、换行、LaTeX 命令），请重新读取文件后复制原文`);
      let offset = occ[0];
      if (occ.length > 1) {
        if (file !== it.anchor.file || !anchorLoc) throw new Error(`edits[${i}].original 在 ${file} 里出现 ${occ.length} 次，请多带一些上下文使其唯一`);
        offset = nearest(occ, anchorLoc.start);
      }
      return { file, original, replacement, offset };
    });
    checkOverlap(resolved);
    it.proposal = { edits: resolved, rationale: String(rationale), fidelity: String(fidelity), summary: String(summary), createdAt: Date.now() };
    if (it.kind === 'formula') it.verdict = 'issue'; // 给了改法就是有问题
    else if (verdict) it.verdict = verdict;
    it.status = 'proposed';
    it.updatedAt = Date.now();
    this.#changed();
    return { id, status: it.status, edits: resolved.length };
  }

  reply(id, message, verdict) {
    const it = this.find(id);
    this.#touch(it.kind === 'formula' ? 'formula' : 'review');
    if (!message?.trim()) throw new Error('回复内容为空');
    if (it.kind === 'formula') {
      if (!['pass', 'issue', 'unsure'].includes(verdict)) throw new Error('公式审核的回复要带 verdict：pass 通过 / issue 有问题 / unsure 拿不准');
      it.verdict = verdict;
    }
    it.thread.push({ role: 'agent', text: message.trim(), at: Date.now() });
    if (it.status === 'claimed' || it.status === 'pending') it.status = 'replied';
    it.updatedAt = Date.now();
    this.#changed();
    return { id, status: it.status };
  }

  // 用户在网页里回复 agent，但不要求重做（只记录）
  note(id, message) {
    const it = this.find(id);
    it.thread.push({ role: 'user', text: message.trim(), at: Date.now() });
    it.updatedAt = Date.now();
    this.#changed();
    return this.view(it);
  }

  releaseExpired() {
    const limit = Date.now() - this.cfg.claimTimeoutMin * 60_000;
    let n = 0;
    for (const it of this.items) if (it.status === 'claimed' && it.claimedAt < limit) { it.status = 'pending'; n++; }
    if (n) this.#changed(true);
    return n;
  }

  // ---- 对照视图 ----

  hunks(id) {
    const it = this.find(id);
    if (!it.proposal) return [];
    const byFile = new Map();
    it.proposal.edits.forEach((e, idx) => {
      if (e.skipped) return;
      if (!byFile.has(e.file)) byFile.set(e.file, []);
      byFile.get(e.file).push({ ...e, idx });
    });
    const out = [];
    for (const [file, edits] of byFile) {
      const { text } = this.files.read(file);
      const ls = lineStarts(text);
      const located = [];
      for (const e of edits) {
        const at = locateEdit(text, e, it.status === 'accepted' ? 'replacement' : 'original');
        if (at === -1) { out.push({ file, missing: true, edits: [{ idx: e.idx, start: 0, end: e.original.length, original: e.original, replacement: e.replacement }], before: e.original }); continue; }
        const len = (it.status === 'accepted' ? e.replacement : e.original).length;
        const [ps, pe] = paragraphRange(text, at, at + len, 1500);
        located.push({ e, at, len, ps, pe });
      }
      located.sort((a, b) => a.ps - b.ps);
      const groups = [];
      for (const l of located) {
        const g = groups[groups.length - 1];
        if (g && l.ps <= g.pe) { g.pe = Math.max(g.pe, l.pe); g.items.push(l); }
        else groups.push({ ps: l.ps, pe: l.pe, items: [l] });
      }
      for (const g of groups) {
        const segment = text.slice(g.ps, g.pe);
        // 已接受时，文件里是改后的文字，把它还原成“改前”用于对照
        let before = segment;
        const rel = g.items.map((l) => ({ ...l, rs: l.at - g.ps })).sort((a, b) => b.rs - a.rs);
        if (it.status === 'accepted') for (const l of rel) before = before.slice(0, l.rs) + l.e.original + before.slice(l.rs + l.len);
        // 重新算每处修改在“改前”文本里的位置
        let shift = 0;
        const editsRel = rel.reverse().map((l) => {
          const start = l.rs + shift;
          if (it.status === 'accepted') shift += l.e.original.length - l.len;
          return { idx: l.e.idx, start, end: start + l.e.original.length, original: l.e.original, replacement: l.e.replacement };
        });
        out.push({ file, lineStart: offsetToLine(ls, g.ps), missing: false, before, edits: editsRel });
      }
    }
    return out;
  }

  // ---- 接受 / 驳回 / 撤销 ----

  accept(id, { replacements = {}, include } = {}) {
    const it = this.find(id);
    if (it.status !== 'proposed' || !it.proposal) throw new Error(it.status === 'rejected' ? `${id} 已被驳回，要写入请先在注释栏“已驳回”里点“恢复方案”` : `${id} 没有待确认的方案（当前：${it.status}）`);
    const chosen = it.proposal.edits
      .map((e, idx) => ({ ...e, idx, replacement: idx in replacements ? String(replacements[idx]).replace(/\r\n/g, '\n') : e.replacement }))
      .filter((e) => !include || include.includes(e.idx));
    if (!chosen.length) throw new Error('没有选中任何修改');

    const byFile = groupBy(chosen, (e) => e.file);
    const plans = [];
    for (const [file, edits] of byFile) {
      const { text } = this.files.read(file);
      for (const e of edits) {
        e.at = locateEdit(text, e, 'original');
        if (e.at === -1) throw new Error(`原文已改，找不到要替换的文字：${e.original.slice(0, 40)}…`);
      }
      checkOverlap(edits.map((e) => ({ ...e, offset: e.at })));
      edits.sort((a, b) => b.at - a.at);
      let out = text;
      for (const e of edits) out = out.slice(0, e.at) + e.replacement + out.slice(e.at + e.original.length);
      // 记录改后文本中的位置，供撤销用
      edits.sort((a, b) => a.at - b.at);
      let shift = 0;
      const applied = edits.map((e) => {
        const r = { idx: e.idx, file, offset: e.at + shift, original: e.original, replacement: e.replacement };
        shift += e.replacement.length - e.original.length;
        return r;
      });
      plans.push({ file, out, applied });
    }
    for (const p of plans) this.files.write(p.file, p.out);

    const log = { id: this.store.nextId('L'), itemId: id, at: Date.now(), edits: plans.flatMap((p) => p.applied), undone: false };
    this.store.data.log.push(log);
    // 方案里记下实际写入的版本，对照视图和撤销都以它为准
    it.proposal.edits = it.proposal.edits.map((e, idx) => {
      const a = log.edits.find((x) => x.idx === idx);
      return a ? { ...e, replacement: a.replacement, offset: a.offset, skipped: false } : { ...e, skipped: true };
    });
    it.status = 'accepted';
    it.acceptedAt = Date.now();
    it.confirmedAt = null;
    it.logId = log.id;
    it.updatedAt = Date.now();
    this.#changed();
    this.emit('files');
    return { id, status: it.status, files: plans.map((p) => p.file) };
  }

  reject(id, reason = '') {
    const it = this.find(id);
    if (!['proposed', 'replied', 'pending', 'claimed'].includes(it.status)) throw new Error(`${id} 当前不能驳回`);
    if (it.proposal) it.history.push({ proposal: it.proposal, verdict: 'rejected', reason, at: Date.now() });
    if (reason.trim()) it.thread.push({ role: 'user', text: `驳回：${reason.trim()}`, at: Date.now() });
    it.status = 'rejected';
    it.updatedAt = Date.now();
    this.#changed();
    return this.view(it);
  }

  restore(id) {
    const it = this.find(id);
    if (it.status !== 'rejected' || !it.proposal) throw new Error(`${id} 没有可恢复的方案`);
    const last = it.history[it.history.length - 1];
    if (last?.verdict === 'rejected' && last.proposal === it.proposal) it.history.pop();
    else if (last?.verdict === 'rejected') it.history.pop();
    it.status = 'proposed';
    it.updatedAt = Date.now();
    this.#changed();
    return this.view(it);
  }

  undo(id) {
    const it = this.find(id);
    if (it.status !== 'accepted') throw new Error(`${id} 不是已接受状态`);
    const log = this.store.data.log.find((l) => l.id === it.logId);
    if (!log || log.undone) throw new Error('找不到写入记录');
    const plans = [];
    for (const [file, edits] of groupBy(log.edits, (e) => e.file)) {
      const { text } = this.files.read(file);
      const located = edits.map((e) => {
        const at = locateEdit(text, { original: e.replacement, offset: e.offset }, 'original');
        if (at === -1) throw new Error(`修改处已被再次改动，无法自动撤销：${e.replacement.slice(0, 40)}…`);
        return { ...e, at };
      }).sort((a, b) => b.at - a.at);
      let out = text;
      for (const e of located) out = out.slice(0, e.at) + e.original + out.slice(e.at + e.replacement.length);
      plans.push({ file, out });
    }
    for (const p of plans) this.files.write(p.file, p.out);
    log.undone = true;
    // 回到待确认，offset 重新指向改前文本
    for (const e of it.proposal.edits) {
      e.skipped = false;
      const t = this.files.read(e.file).text;
      const occ = findAll(t, e.original);
      if (occ.length) e.offset = nearest(occ, e.offset);
    }
    it.status = 'proposed';
    it.updatedAt = Date.now();
    this.#changed();
    this.emit('files');
    return this.view(it);
  }

  // 已写入、还没“确认修改”的改动：网页在源码和 PDF 上标黄。
  // 每处给出替换后文字在当前文件里的位置（文件被手动改过、找不到的就不标）
  changes() {
    const out = [];
    for (const it of this.items) {
      if (it.status !== 'accepted' || it.confirmedAt || !it.proposal) continue;
      it.proposal.edits.forEach((e, idx) => {
        if (e.skipped) return;
        let text;
        try { text = this.files.read(e.file).text; } catch { return; }
        const at = e.replacement ? locateEdit(text, { original: e.replacement, offset: e.offset }, 'original') : -1;
        if (e.replacement && at === -1) return;
        const ls = lineStarts(text);
        const pos = at === -1 ? Math.min(e.offset ?? 0, text.length) : at;
        out.push({
          id: `${it.id}:${idx}`, itemId: it.id, file: e.file,
          from: pos, to: pos + e.replacement.length,
          lineStart: offsetToLine(ls, pos), lineEnd: offsetToLine(ls, pos + e.replacement.length),
          original: e.original, replacement: e.replacement,
        });
      });
    }
    return out;
  }

  // “确认修改”：去掉标黄。ids 不给就是全部
  confirmChanges(ids) {
    let n = 0;
    for (const it of this.items) {
      if (it.status !== 'accepted' || it.confirmedAt) continue;
      if (ids && !ids.includes(it.id)) continue;
      it.confirmedAt = Date.now();
      n++;
    }
    if (n) this.#changed();
    return { confirmed: n };
  }

  stats() {
    const counts = {};
    for (const it of this.items) counts[it.status] = (counts[it.status] || 0) + 1;
    return counts;
  }
}

// 在 text 里找 edit 的 original（或 replacement）：优先原位置，否则唯一出现处，多处时取离原位置最近的
function locateEdit(text, e, field) {
  const s = e[field];
  if (e.offset != null && text.startsWith(s, e.offset)) return e.offset;
  const occ = findAll(text, s);
  if (!occ.length) return -1;
  return occ.length === 1 ? occ[0] : nearest(occ, e.offset ?? 0);
}

function formulaInstructions(it, skill) {
  const pos = it.job ? `这是公式审核任务 ${it.job.id}（${it.job.label}）的第 ${it.job.index}/${it.job.total} 个公式，按顺序发来，前面的公式你可能已经审过。` : '';
  const how = skill ? `先调用 get_skill("${skill.name}") 读取审核规则（第一次读，之后复用）。` : '';
  return `公式审核：${pos}${how}只审 quote 这一个公式（必要时结合 context 里前文的定义和推导），检查符号定义与一致性、维数、上下标与字体、和前文推导是否衔接、编号与引用。` +
    '结论三选一：没问题 → reply(id, 一句话说明, verdict="pass")；有问题且能给出确定的改法 → submit_proposal（只改这个公式或它紧邻的定义句，rationale 写清是哪一项检查发现的问题）；' +
    '有问题但需要作者判断、或拿不准 → reply(id, 写清问题和建议, verdict="issue" 或 "unsure")。不要为了改而改，排版风格类的小差异不算问题。';
}

function checkOverlap(edits) {
  for (const [, list] of groupBy(edits, (e) => e.file)) {
    const s = [...list].sort((a, b) => a.offset - b.offset);
    for (let i = 1; i < s.length; i++)
      if (s[i].offset < s[i - 1].offset + s[i - 1].original.length) throw new Error('有两处修改重叠，请合并成一处');
  }
}

function groupBy(arr, key) {
  const m = new Map();
  for (const x of arr) {
    const k = key(x);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(x);
  }
  return m;
}
