// PDF 上点到的公式 -> 源码位置（POST /api/formula）
import { resolveFormula } from '../web/lib/mathsrc.js';

export function locateFormula(files, body) {
  const { rel } = files.resolve(String(body.file));
  const { text } = files.read(rel);
  const r = resolveFormula(text, {
    line: Number(body.line) || 1,
    kind: body.kind === 'display' ? 'display' : body.kind === 'inline' ? 'inline' : undefined,
    before: String(body.before || '').slice(0, 60),
    after: String(body.after || '').slice(0, 60),
  });
  return r ? { file: rel, ...r } : null;
}
