// 迁移进度门禁：可选模块必须「已分块」或「显式登记仍在核心包」，两者都不许漏。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { MODULE_REGISTRY } from '../../src/modules/registry.ts';

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const readJson = (relative) => JSON.parse(readFileSync(join(desktopRoot, relative), 'utf8'));

test('每个可选模块都在「已分块」或「仍在核心白名单」里，且没有过期条目', () => {
  const allow = readJson('modules/bundled-allowlist.json');
  const chunks = Object.keys(readJson('modules/chunks.json').chunks);
  const optional = MODULE_REGISTRY.filter((module) => module.kind === 'optional').map((module) => module.id);
  const allowlisted = allow.bundledInCore;

  for (const id of optional) {
    assert.ok(
      chunks.includes(id) || allowlisted.includes(id),
      `可选模块既未分块也未登记：${id}（新模块不能默认塞进核心包）`
    );
  }
  for (const id of allowlisted) {
    assert.ok(optional.includes(id), `白名单里的模块不存在或不是可选模块：${id}`);
    assert.equal(chunks.includes(id), false, `已迁出的模块应从白名单删除：${id}`);
  }
  for (const id of chunks) {
    assert.ok(optional.includes(id), `分块配置里的模块不是可选模块：${id}`);
  }
  // 已分块 + 仍在核心 = 全部可选模块，不允许重复计数
  assert.equal(chunks.length + allowlisted.length, optional.length, '分块与白名单必须正好覆盖全部可选模块');
});
