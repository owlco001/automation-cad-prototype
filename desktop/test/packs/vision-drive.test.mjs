import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, test } from 'node:test';
import { PackRegistry } from '../../src/packs/registry.ts';

const here = dirname(fileURLToPath(import.meta.url));
const builtinDir = resolve(here, '../../../packs/builtin');
const PACK_IDS = ['iec-cn', 'smc-cn', 'servo-cn', 'sensor-cn', 'pneumatic-cn', 'vision-cn', 'drive-cn', 'safety-cn', 'frame-cn'];
const VISION_TYPES = new Set(['camera', 'lens', 'light', 'reader', 'controller']);
const DRIVE_TYPES = new Set(['ballscrew', 'rail', 'reducer', 'coupling', 'belt', 'rack', 'module']);
const VISION_REQUIRED = {
  camera: ['type', 'resolution', 'sensorSize', 'interface', 'powerW'],
  lens: ['type', 'focalLength', 'sensorSize', 'interface', 'fov', 'workingDistance'],
  light: ['type', 'shape', 'color', 'powerW'],
  reader: ['type', 'resolution', 'sensorSize', 'interface', 'powerW'],
  controller: ['type', 'controllerType', 'interface', 'powerW']
};
const DRIVE_REQUIRED = {
  ballscrew: ['type', 'lead', 'accuracy', 'loadRating', 'repeatability', 'length'],
  rail: ['type', 'railWidth', 'loadRating', 'repeatability', 'length'],
  reducer: ['type', 'ratio', 'torqueNm', 'repeatability'],
  coupling: ['type', 'torqueNm', 'length'],
  belt: ['type', 'profile', 'pitch'],
  rack: ['type', 'module', 'length', 'loadRating'],
  module: ['type', 'lead', 'stroke', 'loadRating', 'repeatability']
};
let sandbox;
let userDir;
let stateFile;

function readPack(id) {
  return JSON.parse(readFileSync(join(builtinDir, id, 'parts.json'), 'utf8'));
}
function readManifest(id) {
  return JSON.parse(readFileSync(join(builtinDir, id, 'manifest.json'), 'utf8'));
}
function registry(options = {}) {
  return new PackRegistry({ builtinDir, userDir, stateFile, ...options });
}

const vision = readPack('vision-cn');
const drive = readPack('drive-cn');

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'cad-vision-drive-'));
  userDir = join(sandbox, 'packs');
  stateFile = join(sandbox, 'packs-state.json');
});
afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

test('vision-cn 容量下限与类型覆盖', () => {
  assert.ok(vision.length >= 26, `vision-cn 仅 ${vision.length} 条`);
  const types = new Set(vision.map((part) => part.specs.type));
  for (const type of VISION_TYPES) assert.ok(types.has(type), `缺少类型 ${type}`);
});

test('drive-cn 容量下限与类型覆盖', () => {
  assert.ok(drive.length >= 30, `drive-cn 仅 ${drive.length} 条`);
  const types = new Set(drive.map((part) => part.specs.type));
  for (const type of DRIVE_TYPES) assert.ok(types.has(type), `缺少类型 ${type}`);
});

test('vision-cn manifest 版本、条目数与分类一致', () => {
  const manifest = readManifest('vision-cn');
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.id, 'vision-cn');
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.equal(manifest.partsCount, vision.length);
  assert.deepEqual([...manifest.categories].sort(), [...new Set(vision.map((part) => part.category))].sort());
  for (const key of ['name', 'vendor', 'license', 'description']) assert.ok(manifest[key], `缺少 manifest.${key}`);
  assert.ok(Array.isArray(manifest.keywords) && manifest.keywords.length > 0);
});

test('drive-cn manifest 版本、条目数与分类一致', () => {
  const manifest = readManifest('drive-cn');
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.id, 'drive-cn');
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.equal(manifest.partsCount, drive.length);
  assert.deepEqual([...manifest.categories].sort(), [...new Set(drive.map((part) => part.category))].sort());
  for (const key of ['name', 'vendor', 'license', 'description']) assert.ok(manifest[key], `缺少 manifest.${key}`);
  assert.ok(Array.isArray(manifest.keywords) && manifest.keywords.length > 0);
});

test('vision-cn 每类必填字段完整', () => {
  for (const part of vision) {
    assert.ok(VISION_TYPES.has(part.specs.type), `${part.id} type 非法：${part.specs.type}`);
    for (const key of VISION_REQUIRED[part.specs.type]) {
      assert.ok(Object.hasOwn(part.specs, key), `${part.id} 缺少 specs.${key}`);
    }
  }
});

test('drive-cn 每类必填字段完整', () => {
  for (const part of drive) {
    assert.ok(DRIVE_TYPES.has(part.specs.type), `${part.id} type 非法：${part.specs.type}`);
    for (const key of DRIVE_REQUIRED[part.specs.type]) {
      assert.ok(Object.hasOwn(part.specs, key), `${part.id} 缺少 specs.${key}`);
    }
  }
});

test('vision-cn 每条记录数据来源，尺寸只带官方 source', () => {
  for (const part of vision) {
    assert.equal(typeof part.specs.数据来源, 'string', `${part.id} 缺少数据来源`);
    assert.match(part.specs.数据来源, /官方/, `${part.id} 数据来源未标注官方`);
    if (part.dims) {
      assert.ok(part.dims.source, `${part.id} dims 缺 source`);
      for (const axis of ['w', 'h', 'd']) assert.ok(part.dims[axis] > 0, `${part.id} dims.${axis} 非法`);
      assert.notEqual(part.dims.estimated, true, `${part.id} 不应使用推定尺寸`);
    }
  }
});

test('drive-cn 每条记录数据来源，尺寸只带官方 source', () => {
  for (const part of drive) {
    assert.equal(typeof part.specs.数据来源, 'string', `${part.id} 缺少数据来源`);
    assert.match(part.specs.数据来源, /官方/, `${part.id} 数据来源未标注官方`);
    if (part.dims) {
      assert.ok(part.dims.source, `${part.id} dims 缺 source`);
      for (const axis of ['w', 'h', 'd']) assert.ok(part.dims[axis] > 0, `${part.id} dims.${axis} 非法`);
      assert.notEqual(part.dims.estimated, true, `${part.id} 不应使用推定尺寸`);
    }
  }
});

test('两个新包不录入价格', () => {
  for (const part of [...vision, ...drive]) {
    assert.equal(Object.hasOwn(part, 'price'), false, `${part.id} 不应有 price`);
    assert.equal(Object.hasOwn(part.specs, '价格'), false, `${part.id} 不应有 specs.价格`);
  }
});

test('9 个元器件包 id 全局唯一', () => {
  const seen = new Map();
  for (const id of PACK_IDS) {
    for (const part of readPack(id)) {
      assert.equal(seen.has(part.id), false, `${part.id} 冲突：${seen.get(part.id)} / ${id}`);
      seen.set(part.id, id);
    }
  }
  assert.equal(seen.size, 617);
});

test('9 个元器件包非 alias 型号全局唯一', () => {
  const seen = new Map();
  for (const id of PACK_IDS) {
    for (const part of readPack(id)) {
      if (part.aliasOf) continue;
      assert.equal(seen.has(part.model), false, `${part.model} 型号重复：${seen.get(part.model)} / ${id}`);
      seen.set(part.model, id);
    }
  }
  assert.equal(seen.size, 612);
});

test('vision-cn 单包体积不超过 400 KB', () => {
  const bytes = statSync(join(builtinDir, 'vision-cn', 'parts.json')).size;
  assert.ok(bytes <= 400 * 1024, `vision-cn 超过 400 KB：${bytes}`);
});

test('drive-cn 单包体积不超过 400 KB', () => {
  const bytes = statSync(join(builtinDir, 'drive-cn', 'parts.json')).size;
  assert.ok(bytes <= 400 * 1024, `drive-cn 超过 400 KB：${bytes}`);
});

test('scan 只读 10 个 manifest，不读取新包 parts.json', async () => {
  const reads = [];
  const instance = registry({
    readTextFile: (path) => {
      reads.push(path);
      return readFileSync(path, 'utf8');
    }
  });
  const packs = await instance.scan();
  assert.equal(packs.length, 10);
  assert.deepEqual(new Set(packs.map((pack) => pack.id)), new Set([...PACK_IDS, 'pricebook-cn']));
  assert.equal(reads.filter((path) => path.endsWith('manifest.json')).length, 10);
  assert.equal(reads.filter((path) => path.endsWith('parts.json')).length, 0);
});

test('packId 过滤只加载目标新包', () => {
  const instance = registry();
  assert.deepEqual(instance.loadedPackIds(), []);
  assert.equal(instance.listParts({ packId: 'vision-cn' }).length, vision.length);
  assert.deepEqual(instance.loadedPackIds(), ['vision-cn']);
  const driveOnly = registry();
  assert.equal(driveOnly.listParts({ packId: 'drive-cn' }).length, drive.length);
  assert.deepEqual(driveOnly.loadedPackIds(), ['drive-cn']);
});

test('全库搜索能命中 vision-cn 型号', () => {
  const instance = registry();
  const hits = instance.listParts({ q: 'MV-CS050' });
  assert.deepEqual(hits.map((part) => part.id).sort(), ['HIK-MV-CS050-10GC', 'HIK-MV-CS050-10GM']);
});

test('全库搜索能命中 drive-cn 型号', () => {
  const instance = registry();
  const hits = instance.listParts({ q: 'SFU1605-4' });
  assert.deepEqual(hits.map((part) => part.id), ['TBI-SFU1605-4']);
});

test('分类聚合正确：工业相机与减速机', () => {
  const instance = registry();
  const cameras = instance.listParts({ category: '工业相机' });
  assert.equal(cameras.length, 11);
  assert.equal(cameras.every((part) => part.specs.type === 'camera'), true);
  assert.deepEqual(instance.loadedPackIds(), ['vision-cn']);
  const reducers = instance.listParts({ category: '减速机' });
  assert.equal(reducers.length, 8);
  assert.equal(reducers.every((part) => part.specs.type === 'reducer'), true);
});

test('全库聚合包含 612 个唯一型号与全部新增分类', () => {
  const instance = registry();
  const all = instance.listParts();
  assert.equal(all.length, 612);
  assert.equal(new Set(all.map((part) => part.id)).size, 612);
  const categories = new Set(all.map((part) => part.category));
  for (const category of ['工业相机', '镜头', '光源', '光源控制器', '读码器', '视觉控制器', '滚珠丝杠', '直线导轨', '减速机', '联轴器', '同步带', '同步带轮', '齿轮齿条', '直线模组', '安全光栅', '安全继电器', '安全门锁', '急停', '安全PLC', '工业铝型材', '连接件', '防护板材', '脚轮与地脚', '门与把手', '输送段']) {
    assert.ok(categories.has(category), `缺少分类 ${category}`);
  }
  assert.equal(instance.metrics().loadedPacks, 9);
  assert.equal(instance.metrics().packCount, 10);
});

test('vision-cn 相机/镜头关键参数语义正确', () => {
  const cameras = vision.filter((part) => part.specs.type === 'camera');
  for (const part of cameras) {
    assert.match(part.specs.resolution, /万像素/);
    assert.match(part.specs.sensorSize, /″/);
    assert.ok(['GigE', 'USB3', 'CameraLink'].includes(part.specs.interface), `${part.id} interface 非法`);
    assert.ok(part.specs.powerW > 0 && part.specs.powerW < 100);
  }
  const lenses = vision.filter((part) => part.specs.type === 'lens');
  for (const part of lenses) {
    assert.match(part.specs.workingDistance, /mm/);
    assert.match(part.specs.fov, /mm|×/);
    assert.equal(part.specs.interface, 'C-mount');
  }
});

test('drive-cn 丝杠/减速机/联轴器/同步带参数语义正确', () => {
  const ballscrews = drive.filter((part) => part.specs.type === 'ballscrew');
  for (const part of ballscrews) {
    assert.ok([5, 10, 16].includes(part.specs.lead), `${part.id} lead 非法`);
    assert.equal(part.specs.accuracy, 'C7');
    assert.match(part.specs.repeatability, /mm/);
  }
  const reducers = drive.filter((part) => part.specs.type === 'reducer');
  for (const part of reducers) {
    assert.ok([5, 10, 20, 50, 100].includes(part.specs.ratio), `${part.id} ratio 非法`);
    assert.ok(part.specs.torqueNm > 0);
  }
  for (const part of drive.filter((item) => item.specs.type === 'coupling')) assert.ok(part.specs.torqueNm > 0);
  for (const part of drive.filter((item) => item.specs.type === 'belt')) {
    assert.ok(['GT2', 'HTD 5M'].includes(part.specs.profile));
    assert.match(part.specs.pitch, /mm/);
  }
});

test('smoke 计数口径：vision=32 drive=33 packs=10', () => {
  const instance = registry();
  const counts = {
    vision: instance.listParts({ packId: 'vision-cn' }).length,
    drive: instance.listParts({ packId: 'drive-cn' }).length
  };
  assert.deepEqual(counts, { vision: 32, drive: 33 });
  assert.equal(instance.metrics().packCount, 10);
});
