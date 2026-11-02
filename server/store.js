import fs from 'node:fs';
import path from 'node:path';

// 整份状态存一个 JSON 文件，每次改动后原子写回（先写临时文件再改名）
export class Store {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'state.json');
    fs.mkdirSync(dataDir, { recursive: true });
    this.data = { seq: 0, items: [], log: [] };
    if (fs.existsSync(this.file)) this.data = { ...this.data, ...JSON.parse(fs.readFileSync(this.file, 'utf8')) };
  }

  nextId(prefix) {
    this.data.seq += 1;
    return `${prefix}${String(this.data.seq).padStart(4, '0')}`;
  }

  save() {
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 1), 'utf8');
    fs.renameSync(tmp, this.file);
  }
}
