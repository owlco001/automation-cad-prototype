import assert from 'node:assert/strict';
import { test } from 'node:test';
import { plcExportFiles } from '../../src/plcgen/export-files.ts';

test('导出文件路径归一化且不修改输入', () => {
  const source = [{ path: ' ./PLC\\main.st ', content: '程序', extra: true }];
  assert.deepEqual(plcExportFiles(source), [{ path: 'PLC/main.st', content: '程序' }]);
  assert.equal(source[0].path, ' ./PLC\\main.st ');
});

test('导出边界拒绝缺失、过多和非法文件', () => {
  for (const value of [null, {}, []]) assert.throws(() => plcExportFiles(value), /PLC 导出缺少文件/);
  const file = { path: 'main.st', content: '' };
  assert.equal(plcExportFiles(Array(200).fill(file)).length, 200);
  assert.throws(() => plcExportFiles(Array(201).fill(file)), /PLC 导出文件过多/);
  assert.throws(() => plcExportFiles([null]), /PLC 导出文件 1 格式不合法/);
  assert.throws(() => plcExportFiles([{ path: '../escape.st', content: '' }]), /ZIP 条目路径不合法/);
  assert.throws(() => plcExportFiles([{ path: '/escape.st', content: '' }]), /必须是相对路径/);
  assert.throws(() => plcExportFiles([{ path: 'main.st', content: 1 }]), /PLC 导出文件 main.st 缺少正文/);
});

test('正文限制按所有文件 UTF-8 字节总和计算', () => {
  const limit = 20 * 1024 * 1024;
  const content = 'a'.repeat(limit - 3);
  assert.equal(plcExportFiles([{ path: 'a.st', content }, { path: 'b.st', content: '中' }]).length, 2);
  assert.throws(() => plcExportFiles([{ path: 'a.st', content }, { path: 'b.st', content: '中文' }]), /PLC 导出正文超过 20MB/);
});
