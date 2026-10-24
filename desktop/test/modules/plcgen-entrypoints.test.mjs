import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildOptionalSyncPlcPayload, buildSyncPlcPayload } from '../../src/sync/plc.ts';

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
