// 按配方（recipe）依次运行编译工具，配方和工具的写法与 LaTeX Workshop 的 latex.recipes / latex.tools 相同。
// 参数里的占位符：%DOC% 主文件去掉 .tex，%DOCFILE% 主文件名，%JOBNAME% 输出文件名（PDF 去掉 .pdf）
import { spawn, execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';

export function expandArgs(args, cfg) {
  const docfile = cfg.mainTex;
  const doc = docfile.replace(/\.tex$/, '');
  const jobname = cfg.pdf.replace(/\.pdf$/, '');
  return args.map((a) => a.replaceAll('%DOCFILE%', docfile).replaceAll('%DOC%', doc).replaceAll('%JOBNAME%', jobname));
}

export function recipeSteps(cfg, name) {
  const recipe = cfg.recipes.find((r) => r.name === name);
  if (!recipe) throw new Error(`没有编译配方：${name}`);
  return recipe.tools.map((t) => {
    const tool = cfg.tools.find((x) => x.name === t);
    if (!tool) throw new Error(`配方 ${name} 用到的工具 ${t} 没有定义`);
    return { name: tool.name, command: tool.command, args: expandArgs(tool.args || [], cfg) };
  });
}

export class Compiler extends EventEmitter {
  constructor(cfg) {
    super();
    this.cfg = cfg;
    this.state = { running: false, recipe: null, step: 0, steps: [], startedAt: null, finishedAt: null, ok: null, errors: [], tail: [] };
    this.proc = null;
    this.stopped = false;
  }

  recipes() {
    return { names: this.cfg.recipes.map((r) => r.name), default: this.cfg.defaultRecipe || this.cfg.recipes[0]?.name };
  }

  start(name = this.recipes().default) {
    if (this.state.running) return false;
    const steps = recipeSteps(this.cfg, name);
    this.stopped = false;
    this.state = { running: true, recipe: name, step: 0, steps: steps.map((s) => s.name), startedAt: Date.now(), finishedAt: null, ok: null, errors: [], tail: [] };
    this.emit('state', this.state);
    this.#runStep(steps, 0);
    return true;
  }

  #runStep(steps, i) {
    if (i >= steps.length) return this.#finish(true, null);
    const s = steps[i];
    this.state.step = i + 1;
    this.#line(`>>> [${i + 1}/${steps.length}] ${s.command} ${s.args.join(' ')}`);
    this.emit('state', this.state);
    const p = spawn(s.command, s.args, { cwd: this.cfg.projectRoot, windowsHide: true });
    this.proc = p;
    let buf = '';
    const onData = (chunk) => {
      buf += chunk.toString('utf8');
      const lines = buf.split(/\r?\n/);
      buf = lines.pop();
      for (const l of lines) this.#line(l);
    };
    p.stdout.on('data', onData);
    p.stderr.on('data', onData);
    p.on('error', (e) => this.#finish(false, `${s.command} 启动失败：${e.message}`));
    p.on('close', (code) => {
      if (buf) this.#line(buf);
      this.proc = null;
      if (this.stopped) return this.#finish(false, '已终止');
      if (code !== 0) return this.#finish(false, `${s.name} 退出码 ${code}`);
      this.#runStep(steps, i + 1);
    });
  }

  stop() {
    if (!this.state.running || !this.proc) return false;
    this.stopped = true;
    const pid = this.proc.pid;
    // latexmk 会再起子进程，Windows 上要连进程树一起结束
    if (process.platform === 'win32') execFile('taskkill', ['/PID', String(pid), '/T', '/F'], () => {});
    else this.proc.kill('SIGTERM');
    return true;
  }

  #line(l) {
    this.state.tail.push(l);
    if (this.state.tail.length > 300) this.state.tail.shift();
    const m = /^(?:\.\/)?([^:\s][^:]*\.tex):(\d+): (.*)$/.exec(l);
    if (m && this.state.errors.length < 50) this.state.errors.push({ file: m[1], line: +m[2], message: m[3] });
    if (/^(>>> |Latexmk: |Run number|Output written)/.test(l)) this.emit('progress', l);
  }

  #finish(ok, message) {
    if (!this.state.running) return;
    this.state.running = false;
    this.state.ok = ok;
    this.state.finishedAt = Date.now();
    if (message) this.state.message = message;
    this.proc = null;
    this.emit('state', this.state);
    this.emit('done', this.state);
  }
}
