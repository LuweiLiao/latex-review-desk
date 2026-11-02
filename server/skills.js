import fs from 'node:fs';
import path from 'node:path';

// 读 SKILL.md 开头的 YAML frontmatter，只取 name 和 description（支持 | / > 多行写法）
export function parseFrontmatter(src) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(src);
  if (!m) return {};
  const out = {};
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z_-]+):\s*(.*)$/.exec(lines[i]);
    if (!kv) continue;
    let [, k, v] = kv;
    if (v === '|' || v === '>' || v === '|-' || v === '>-' || v === '') {
      const parts = [];
      while (i + 1 < lines.length && (/^\s+/.test(lines[i + 1]) || lines[i + 1] === '')) parts.push(lines[++i].trim());
      v = parts.join(v.startsWith('|') ? '\n' : ' ').trim();
    }
    out[k] = v.replace(/^["']|["']$/g, '');
  }
  return out;
}

export function listSkills(cfg) {
  const seen = new Map();
  for (const dir of cfg.skillDirs) {
    if (!fs.existsSync(dir)) continue;
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!ent.isDirectory() && !ent.isSymbolicLink()) continue;
      const file = path.join(dir, ent.name, 'SKILL.md');
      if (!fs.existsSync(file)) continue;
      const fm = parseFrontmatter(fs.readFileSync(file, 'utf8'));
      const name = fm.name || ent.name;
      if (seen.has(name)) continue;
      seen.set(name, { name, description: fm.description || '', path: file.replace(/\\/g, '/'), dir: dir.replace(/\\/g, '/') });
    }
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function getSkill(cfg, name) {
  const s = listSkills(cfg).find((x) => x.name === name);
  if (!s) return null;
  return { ...s, content: fs.readFileSync(s.path, 'utf8') };
}
