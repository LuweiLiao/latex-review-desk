import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { loadConfig } from '../server/config.js';
import { Projects } from '../server/projects.js';

test('explicit config paths use config directory and CLI overrides are honored', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'review-config-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'paper'));
  const file = path.join(root, 'settings.json');
  fs.writeFileSync(file, JSON.stringify({ projectRoot: './paper', dataDir: './state', mainTex: 'paper.tex', skillDirs: ['./rules'] }));
  const cfg = loadConfig(file, { THESIS_REVIEW_CONFIG_DIR: path.join(root, 'global'), THESIS_REVIEW_PORT: '4455', THESIS_REVIEW_MAIN_TEX: 'other.tex' });
  assert.equal(cfg.projectRoot, path.join(root, 'paper'));
  assert.equal(cfg.dataDir, path.join(root, 'state'));
  assert.equal(cfg.mainTex, 'other.tex'); assert.equal(cfg.pdf, 'other.pdf'); assert.equal(cfg.port, 4455);
  assert.ok(cfg.skillDirs.includes(path.join(root, 'rules')));
  assert.equal(cfg.defaultSkill, 'basic-polish');
});

test('new CLI project root selects correct saved project without overwriting prior settings', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'review-cli-project-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configDir = path.join(root, 'global');
  const cfg = (name) => {
    const projectRoot = path.join(root, name); fs.mkdirSync(projectRoot, { recursive: true });
    fs.writeFileSync(path.join(projectRoot, 'main.tex'), '\\documentclass{article}');
    return loadConfig(null, { THESIS_REVIEW_PROJECT: projectRoot, THESIS_REVIEW_CONFIG_DIR: configDir, THESIS_REVIEW_DATA_DIR: path.join(root, `${name}-state`) });
  };
  const opts = { registryDir: path.join(configDir, 'projects') };
  const a = new Projects(cfg('a'), opts);
  const idA = a.activeProjectId;
  a.update(idA, { writingRules: 'Preserve this setting.' });
  const b = new Projects(cfg('b'), opts);
  assert.notEqual(b.activeProjectId, idA);
  assert.equal(b.list().length, 2);
  const reopened = new Projects(cfg('a'), opts);
  assert.equal(reopened.activeProjectId, idA);
  assert.equal(reopened.get(idA).writingRules, 'Preserve this setting.');
});
