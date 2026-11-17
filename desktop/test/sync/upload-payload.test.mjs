import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseSyncPayload } from '../../src/sync/upload-payload.ts';

const payload = (patch = {}) => ({
  projectName: '装配体', bomCsv: '名称,数量', reportHtml: '<html></html>',
  glb: new Uint8Array([1, 2]), dxf: 'DXF',
  bom: [{ name: ' 底板 ', spec: ' A ', mat: ' 铝 ', remark: ' 备注 ' }], ...patch
});

test('上传边界保留文本并规范化 BOM 默认值', () => {
  const result = parseSyncPayload(payload());
  assert.equal(result.projectName, '装配体');
  assert.equal(result.bomCsv, '名称,数量');
  assert.equal(result.dxf, 'DXF');
  assert.deepEqual(result.bom, [{ no: 1, name: '底板', spec: 'A', mat: '铝', qty: 1, remark: '备注' }]);
  assert.equal(Object.hasOwn(result, 'plc'), false);
});

test('二进制视图只保留指定字节范围', () => {
  const bytes = new Uint8Array([9, 1, 2, 9]);
  for (const value of [bytes.subarray(1, 3), new DataView(bytes.buffer, 1, 2)]) {
    const result = parseSyncPayload(payload({ glb: value, bomCsv: value, dxf: value }));
    for (const field of ['glb', 'bomCsv', 'dxf']) assert.deepEqual([...result[field]], [1, 2]);
  }
  assert.deepEqual([...parseSyncPayload(payload({ glb: bytes.buffer })).glb], [9, 1, 2, 9]);
});

test('BOM 显式数值和空备注保持现有语义且不修改输入', () => {
  const bom = [{ no: 7, name: ' X ', qty: 0, remark: ' ' }, { name: 'Y', qty: Infinity }];
  const result = parseSyncPayload(payload({ bom }));
  assert.deepEqual(result.bom, [
    { no: 7, name: 'X', spec: '', mat: '', qty: 0 },
    { no: 2, name: 'Y', spec: '', mat: '', qty: 1 }
  ]);
  assert.equal(bom[0].name, ' X ');
});

test('非法上传输入在边界返回原有错误信息', () => {
  for (const [patch, message] of [
    [{ projectName: 1 }, 'projectName必须是字符串'],
    [{ reportHtml: null }, '报告 HTML必须是字符串'],
    [{ glb: [1] }, 'model.glb必须是字节数组'],
    [{ bomCsv: null }, 'bom.csv必须是字节数组'],
    [{ dxf: null }, 'drawing.dxf必须是字节数组'],
    [{ bom: null }, 'BOM 必须是数组'],
    [{ bom: [null] }, '第 1 条 BOM 不是对象'],
    [{ bom: [{}] }, '第 1 条 BOM 缺少名称']
  ]) assert.throws(() => parseSyncPayload(payload(patch)), { message });
  assert.throws(() => parseSyncPayload(null), { message: '同步数据必须是对象' });
});

const plc = () => ({ target: 'generic', generatedVersion: '1', machineId: 'm1', programFiles: [{ path: 'main.st', content: 'PROGRAM Main' }], mappingCsv: 'IO' });

test('PLC 扩展原样传递支持字段并剥离额外字段', () => {
  const source = plc();
  const result = parseSyncPayload(payload({ plc: { ...source, extra: true } }));
  assert.deepEqual(result.plc, source);
  assert.notEqual(result.plc.programFiles[0], source.programFiles[0]);
});

test('PLC 扩展对象、字段及文件结构严格校验', () => {
  for (const value of [null, [], 'plc']) assert.throws(() => parseSyncPayload(payload({ plc: value })), /PLC 同步数据必须是对象/);
  for (const field of ['target', 'generatedVersion', 'machineId', 'mappingCsv']) {
    assert.throws(() => parseSyncPayload(payload({ plc: { ...plc(), [field]: 1 } })), new RegExp(`PLC ${field} 必须是字符串`));
  }
  for (const [programFiles, message] of [[null, /必须是数组/], [[null], /必须是对象/], [[[]], /必须是对象/], [[{ path: 'x' }], /缺少 path\/content/]]) {
    assert.throws(() => parseSyncPayload(payload({ plc: { ...plc(), programFiles } })), message);
  }
});
