import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildOptionalSyncPlcPayload, buildSyncPlcPayload } from '../../src/sync/plc.ts';
import { PLC_TARGETS } from '../../src/plcgen/types.ts';
import { generateProject, PLC_TARGET_LABELS } from '../../src/plcgen/generate.ts';
import { buildDesignPackage } from '../../src/sync/package.ts';

const validConfig = {
  id: 'module-gate-machine',
  name: '模块门禁测试机',
  stations: ['上料'],
  actuators: [{
    id: 'cyl-1', name: '上料气缸', kind: 'cylinder', station: '上料',
    extendPoint: 'Y0', retractPoint: 'Y1', travelMm: 40, durationMs: 400
  }],
  sensors: [{ point: 'X0', station: '上料', part: 'cyl-1' }],
  safety: { emergencyStop: 'X1', safetyDoor: 'X2' },
  sequence: [{ id: 's1', name: '上料伸出', action: 'set', point: 'Y0', condition: 'X0', timeoutMs: 1000 }]
};

function buildPackage(plc) {
  return buildDesignPackage({
    projectId: 'plc-target-test',
    projectName: 'PLC 目标平台测试',
    appVersion: '1.0.0',
    createdAt: '2026-10-25T00:00:00.000Z',
    bom: [{ no: 1, name: '测试机型', spec: 'TEST-01', qty: 1, mat: 'AL6061' }],
    bomCsv: '序号,名称\r\n1,测试机型\r\n',
    plc
  });
}

test('同步包 PLC 生成入口在关闭时于 generateProject 前返回 MODULE_DISABLED', () => {
  assert.throws(
    () => buildSyncPlcPayload({}, false, true),
    (error) => {
      assert.equal(error.code, 'MODULE_DISABLED');
      assert.match(error.message, /plcgen.*已关闭/i);
      return true;
    }
  );
});

test('factory.plc-sync 关闭时在构建程序或 IO map 前失败关闭', () => {
  assert.throws(
    () => buildSyncPlcPayload({}, true, false),
    (error) => {
      assert.equal(error.code, 'MODULE_DISABLED');
      assert.match(error.message, /factory\.plc-sync.*已关闭/);
      return true;
    }
  );
  assert.equal(buildOptionalSyncPlcPayload(null, true, false), undefined);
  assert.equal(buildOptionalSyncPlcPayload(null, true, false, 'unsupported-target'), undefined);
});

test('同步包 PLC 生成入口启用时仍生成文件、版本和 IO 映射', () => {
  const result = buildSyncPlcPayload(validConfig, true, true);
  assert.equal(result.machineId, validConfig.id);
  assert.equal(result.target, 'generic');
  assert.ok(result.generatedVersion);
  assert.equal(result.programFiles.length, 10);
  assert.ok(result.programFiles.some((file) => file.path === 'src/OB1_Main.st'));
  assert.match(result.mappingCsv, /地址|Address/i);
});

test('同步 PLC 目标默认 generic，并写入 manifest.plc', () => {
  const result = buildOptionalSyncPlcPayload(validConfig, true, true);
  assert.equal(result.target, 'generic');
  assert.equal(buildPackage(result).manifest.plc.target, 'generic');
});

test('每个受支持 PLC 目标均进入 manifest 并生成对应平台说明', () => {
  for (const target of PLC_TARGETS) {
    const payload = buildOptionalSyncPlcPayload(validConfig, true, true, target);
    assert.equal(payload.target, target);
    assert.equal(buildPackage(payload).manifest.plc.target, target);

    const generated = generateProject({ config: validConfig, target });
    assert.equal(generated.ok, true);
    if (!generated.ok) continue;
    const readme = generated.files.find((file) => file.path === 'README.md')?.content ?? '';
    assert.ok(readme.includes(`目标平台：${PLC_TARGET_LABELS[target]}`), `${target} 的平台说明应匹配选择值`);
  }
});

test('同步 PLC 入口拒绝不在目标白名单中的运行时值', () => {
  assert.throws(
    () => buildOptionalSyncPlcPayload(validConfig, true, true, 'arbitrary-target'),
    /PLC 同步目标平台不受支持/
  );
});
