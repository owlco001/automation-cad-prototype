import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { PlcManager } from '../../src/plc/manager.ts';

const points = [{ id: 'Y0', name: '输出', area: 'coil', address: 0, dataType: 'bool', writable: true }];
let sandbox;

afterEach(() => {
  if (sandbox) rmSync(sandbox, { recursive: true, force: true });
  sandbox = null;
});

class FakeAdapter {
  constructor(kind, delayMs = 0) {
    this.kind = kind;
    this.delayMs = delayMs;
    this.state = 'disconnected';
    this.connected = 0;
    this.disconnected = 0;
    this.values = { Y0: false };
    this.listener = null;
  }
  async connect() { this.state = 'connected'; this.connected += 1; }
  async disconnect() { this.state = 'disconnected'; this.disconnected += 1; }
  async read(id) { return this.values[id]; }
  async write(id, value) { this.values[id] = value; this.listener?.({ [id]: value }); }
  async readAll() {
    if (this.delayMs) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    return { ...this.values };
  }
  subscribe(callback) { this.listener = callback; callback({ ...this.values }); return () => { this.listener = null; }; }
  status() { return this.state; }
}

function makeManager(delayMs = 0) {
  sandbox = mkdtempSync(join(tmpdir(), 'plc-manager-test-'));
  const configFile = join(sandbox, 'plc.json');
  const created = [];
  const manager = new PlcManager({
    configFile,
    timeoutMs: 500,
    createAdapter: (kind) => {
      const adapter = new FakeAdapter(kind, delayMs);
      created.push(adapter);
      return adapter;
    }
  });
  return { manager, created, configFile };
}

test('manager 连接仿真 PLC、持久化 plc.json 并广播状态与值', async () => {
  const { manager, configFile } = makeManager();
  const statuses = [];
  const values = [];
  manager.on('status', (status) => statuses.push(status.status));
  manager.on('values', (snapshot) => values.push(snapshot));
  const result = await manager.connect({ kind: 'sim', points, rules: [{ target: 'Y0', expr: 'Y0' }] });
  assert.equal(result.ok, true);
  assert.equal(manager.getStatus().status, 'connected');
  const saved = JSON.parse(readFileSync(configFile, 'utf8'));
  assert.equal(saved.kind, 'sim');
  assert.equal(saved.points[0].id, 'Y0');
  assert.equal((await manager.read('Y0')).data, false);
  assert.equal((await manager.write('Y0', true)).ok, true);
  assert.equal((await manager.readAll()).data.Y0, true);
  assert.ok(statuses.includes('connected'));
  assert.equal(values.at(-1).Y0, true);
  const subscribed = [];
  assert.equal(manager.subscribe((snapshot) => subscribed.push(snapshot)).ok, true);
  await manager.force('Y0', false);
  assert.equal(subscribed.at(-1).Y0, false);
  await manager.disconnect();
  assert.equal(manager.getStatus().status, 'disconnected');
});

test('manager 切换适配器先断开旧连接，非法配置返回中文错误', async () => {
  const { manager, created } = makeManager();
  assert.equal((await manager.connect({ kind: 'sim', points })).ok, true);
  assert.equal((await manager.connect({ kind: 'modbus', host: '127.0.0.1', port: 502, points })).ok, true);
  assert.equal(created[0].disconnected, 1);
  assert.equal(manager.getStatus().kind, 'modbus');
  const invalid = await manager.connect({ kind: 'rest', points });
  assert.equal(invalid.ok, false);
  assert.match(invalid.message, /不支持的 PLC 适配器类型/);
});

test('manager 统一超时返回中文错误', async () => {
  makeManager();
  const managerSlow = new PlcManager({
    configFile: join(sandbox, 'plc.json'),
    timeoutMs: 30,
    createAdapter: (kind) => new FakeAdapter(kind, 120)
  });
  assert.equal((await managerSlow.connect({ kind: 'sim', points })).ok, true);
  const result = await managerSlow.readAll();
  assert.equal(result.ok, false);
  assert.match(result.message, /读取全部点位.*超时/);
});

test('manager 越界仿真初始值在适配器创建前作为 INVALID_CONFIG 拒绝', async () => {
  const { manager, created } = makeManager();
  const result = await manager.connect({
    kind: 'sim',
    points: [{ id: 'R0', name: '有符号寄存器', area: 'holding', address: 0, dataType: 'int16' }],
    initialValues: { R0: 32768 }
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'INVALID_CONFIG');
  assert.match(result.message, /R0.*int16 范围/);
  assert.equal(created.length, 0, '无效配置不得创建或连接适配器');
});

test('manager 读取 plc.json 时对坏 JSON 返回中文错误', async () => {
  const { manager, configFile } = makeManager();
  writeFileSync(configFile, '{bad json', 'utf8');
  const result = manager.getConfig();
  assert.equal(result.ok, false);
  assert.match(result.message, /plc\.json 解析失败/);
  assert.throws(() => manager.readConfigFile(), /plc\.json 解析失败/);
});
