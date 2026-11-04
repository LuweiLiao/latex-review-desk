import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chooseFolder } from '../server/folder-picker.js';

test('Windows original-folder selection uses native dialog and preserves Chinese paths', async () => {
  const result = await chooseFolder({ platform: 'win32', initialPath: 'D:\\论文', run: async (command, args, options) => {
    assert.equal(command, 'powershell.exe');
    assert.ok(args.includes('-STA'));
    const script = Buffer.from(args.at(-1), 'base64').toString('utf16le');
    assert.match(script, /IFileOpenDialog/);
    assert.equal(options.env.LRD_PICKER_INITIAL, 'D:\\论文');
    return { stdout: 'D:\\论文\\控制论文\r\n' };
  } });
  assert.equal(result, 'D:\\论文\\控制论文');
});

test('native cancellation returns no folder without registering a project', async () => {
  assert.equal(await chooseFolder({ platform: 'win32', run: async () => ({ stdout: '' }) }), null);
});

test('macOS and Linux use their own directory selection dialogs', async () => {
  for (const [platform, expected] of [['darwin', 'osascript'], ['linux', 'zenity']]) {
    assert.equal(await chooseFolder({ platform, run: async (command) => { assert.equal(command, expected); return { stdout: '/papers/example\n' }; } }), '/papers/example');
  }
});
