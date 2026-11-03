// 输送机方案「应用到工程」的回归测试。
//
// 背景（整机全流程 E2E 撞出来的真问题）：forms.ts 的 belt-line 形态声明
// geometry.kind='conveyor'，MachineFormGeometryKind 里也有 'conveyor'，store.ts 的
// validateForm 甚至连 geometry.conveyor='belt' 都在读；但白名单只列了
// dial/linear/gantry/dual —— 于是任何输送机方案点「应用到工程」都会被判非法。
// 这里锁住「类型里声明过的 kind 必须能通过校验」，以及未知 kind 仍然要拒绝。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseMachineBrief } from '../../src/machine/spec.ts';
import { synthMachine } from '../../src/machine/synth.ts';
import { validateMachineDesign } from '../../src/machine/store.ts';

const PV_BRIEF = '光伏板加工输送机：输送 2000mm 光伏板，线体长 6000mm、带宽 1200mm，需要把光伏板旋转 90° 改变方向，节拍 6 件/分钟';

test('输送机方案（form.geometry.kind=conveyor）能通过应用到工程的校验', () => {
  const design = synthMachine(parseMachineBrief(PV_BRIEF), { parts: [] });
  assert.equal(design.form.geometry.kind, 'conveyor', '皮带线形态必须声明 conveyor');
  assert.equal(design.form.geometry.conveyor, 'belt');

  const normalized = validateMachineDesign(design);
  assert.equal(normalized.form.geometry.kind, 'conveyor');
  assert.equal(normalized.form.geometry.conveyor, 'belt');
  // 转向工位一起过校验：它是这次改动的主线，别在校验环节被削掉
  assert.ok(normalized.config.stations.includes('转向工位'));
  const turner = normalized.config.actuators.find((actuator) => actuator.id === 'turner-rotary');
  assert.equal(turner?.rotationRangeDeg, 90);
});

test('类型里声明的其余 kind（hybrid/cell）同样放行，未知 kind 仍然拒绝', () => {
  for (const kind of ['hybrid', 'cell']) {
    const design = synthMachine(parseMachineBrief('三工位锁螺丝机，节拍 20 件/分钟'), { parts: [] });
    design.form.geometry = { ...design.form.geometry, kind };
    assert.equal(validateMachineDesign(design).form.geometry.kind, kind);
  }

  const broken = synthMachine(parseMachineBrief('三工位锁螺丝机，节拍 20 件/分钟'), { parts: [] });
  broken.form.geometry = { ...broken.form.geometry, kind: 'unknown-kind' };
  assert.throws(() => validateMachineDesign(broken), /geometry\.kind/);
});
