/**
 * STEP 检查器（src/parametric/step-inspect.ts）的单测。
 *
 * 这些用例守住三件事：
 *   1) 实体计数按 `#n=TYPE(` 数得准（手写 STEP 的期望值是逐条算出来的，不是抄的）；
 *   2) 包络只认 B-rep 顶点，不被「参考几何点」带偏；
 *   3) 桩产物（3 KB、1 个实体、6 个面）必须被判 FAIL —— 它就是 `npm run machine:e2e`
 *      里那份 STEP 的样子，不能被门禁放过去。
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import {
  STEP_MIN_BYTES,
  StepInspectError,
  aggregateInspections,
  checkStepExport,
  describeInspection,
  inspectStep
} from '../../src/parametric/step-inspect.ts';

const fixture = (name) => fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));

/** 手写 STEP：两个 100×100×10 方块，各 1 个实体、6 个面，第二个在 X 方向 +500。 */
function twoBoxStep() {
  const lines = [
    'ISO-10303-21;',
    'HEADER;',
    "FILE_DESCRIPTION(('two boxes'),'2;1');",
    "FILE_NAME('two.step','2026-11-04T00:00:00',(''),(''),'hand','hand','');",
    "FILE_SCHEMA(('AUTOMOTIVE_DESIGN'));",
    'ENDSEC;',
    'DATA;',
    '#1=APPLICATION_CONTEXT(\'core\');',
    '#2=SI_UNIT(.MILLI.,.METRE.);',
    // 第一个方块：8 个角点 + 8 个顶点
    '#10=CARTESIAN_POINT(\'\',(0.,0.,0.));',
    '#11=CARTESIAN_POINT(\'\',(100.,0.,0.));',
    '#12=CARTESIAN_POINT(\'\',(100.,100.,0.));',
    '#13=CARTESIAN_POINT(\'\',(0.,100.,0.));',
    '#14=CARTESIAN_POINT(\'\',(0.,0.,10.));',
    '#15=CARTESIAN_POINT(\'\',(100.,0.,10.));',
    '#16=CARTESIAN_POINT(\'\',(100.,100.,10.));',
    '#17=CARTESIAN_POINT(\'\',(0.,100.,10.));',
    '#20=VERTEX_POINT(\'\',#10);',
    '#21=VERTEX_POINT(\'\',#11);',
    '#22=VERTEX_POINT(\'\',#13);',
    '#23=VERTEX_POINT(\'\',#14);',
    '#30=POLY_LOOP(\'\',(#20,#21,#22,#23));',
    '#31=FACE_BOUND(\'\',#30,.T.);',
    '#32=PLANE(\'\',#90);',
    '#40=ADVANCED_FACE(\'\',(#31),#32,.T.);',
    '#41=ADVANCED_FACE(\'\',(#31),#32,.T.);',
    '#42=ADVANCED_FACE(\'\',(#31),#32,.T.);',
    '#43=ADVANCED_FACE(\'\',(#31),#32,.T.);',
    '#44=ADVANCED_FACE(\'\',(#31),#32,.T.);',
    '#45=ADVANCED_FACE(\'\',(#31),#32,.T.);',
    '#50=CLOSED_SHELL(\'\',(#40,#41,#42,#43,#44,#45));',
    "#51=MANIFOLD_SOLID_BREP('box-1',#50);",
    // 第二个方块：只有 1 个实体壳 + 2 个面 + 1 个远离原点的参考点（不该进包络）
    '#60=CARTESIAN_POINT(\'\',(500.,0.,0.));',
    '#61=CARTESIAN_POINT(\'\',(600.,100.,10.));',
    '#62=VERTEX_POINT(\'\',#60);',
    '#63=VERTEX_POINT(\'\',#61);',
    '#70=ADVANCED_FACE(\'\',(#31),#32,.T.);',
    '#71=ADVANCED_FACE(\'\',(#31),#32,.T.);',
    '#80=CLOSED_SHELL(\'\',(#70,#71));',
    "#81=MANIFOLD_SOLID_BREP('box-2',#80);",
    // 参考几何：被切掉的那段圆柱轴心，坐标在实体之外（z=-400）
    '#90=CARTESIAN_POINT(\'\',(0.,0.,-400.));',
    '#91=AXIS2_PLACEMENT_3D(\'\',#90,#92,#93);',
    '#92=DIRECTION(\'\',(0.,0.,1.));',
    '#93=DIRECTION(\'\',(1.,0.,0.));',
    'ENDSEC;',
    'END-ISO-10303-21;'
  ];
  return `${lines.join('\n')}\n`;
}

test('inspectStep：手写 STEP 的实体数按 #n=TYPE( 数准（2 实体 / 2 壳 / 8 面）', () => {
  const inspection = inspectStep(twoBoxStep());
  assert.equal(inspection.header, 'ISO-10303-21');
  assert.equal(inspection.schema, 'AUTOMOTIVE_DESIGN');
  assert.equal(inspection.units, 'MM');
  assert.equal(inspection.solids, 2);
  assert.equal(inspection.shells, 2);
  assert.equal(inspection.faces, 8);
  assert.equal(inspection.vertices, 6);
  // 实体总数 = #1、#2、8 点 + 6 顶点 + 循环/面界/平面/6 面 + 壳/实体 + 5 + 2 面/壳/实体 + 4
  assert.equal(inspection.counts.MANIFOLD_SOLID_BREP, 2);
  assert.equal(inspection.entities, Object.values(inspection.counts).reduce((sum, value) => sum + value, 0));
});

test('inspectStep：包络只算 B-rep 顶点，参考几何点（z=-400）不进包络', () => {
  const inspection = inspectStep(twoBoxStep());
  assert.deepEqual(inspection.bbox?.min, [0, 0, 0]);
  assert.deepEqual(inspection.bbox?.max, [600, 100, 10]);
  assert.deepEqual(inspection.bbox?.size, [600, 100, 10]);
  // 全部坐标点（含参考几何）确实包含了 z=-400 —— 说明两套口径不同，且我们用的是顶点口径
  assert.equal(inspection.rawPointBbox?.min[2], -400);
});

test('inspectStep：不是 STEP 的文件要报错，不是返回空统计', () => {
  assert.throws(() => inspectStep('{"parts": 85}'), StepInspectError);
  assert.throws(() => inspectStep(''), StepInspectError);
  // 只有头没有实体：被截断的文件同样报错
  assert.throws(() => inspectStep('ISO-10303-21;\nHEADER;\nENDSEC;\n'), /没有任何 #n= 实体/);
});

test('aggregateInspections：逐件合计实体/字节，包络取并集', () => {
  const first = inspectStep(twoBoxStep());
  const second = inspectStep(twoBoxStep(), 999);
  const merged = aggregateInspections([first, second]);
  assert.equal(merged.solids, 4);
  assert.equal(merged.shells, 4);
  assert.equal(merged.faces, 16);
  assert.equal(merged.bytes, first.bytes + 999);
  assert.deepEqual(merged.bbox?.size, [600, 100, 10]);
  assert.throws(() => aggregateInspections([]), StepInspectError);
});

test('checkStepExport：桩产物（3 KB / 1 实体 / 6 面）必须 FAIL，且失败原因不是包络', () => {
  const text = readFileSync(fixture('step-stub-3kb.step'));
  const inspection = inspectStep(text.toString('utf8'), text.length);
  // 桩产物的包络是照着参数写的，所以包络这条会 PASS —— 这正是为什么需要字节数/实体数两道闸
  const result = checkStepExport(inspection, { parts: 85, envelopeMm: [6000, 1495, 930] });
  assert.equal(result.ok, false);
  const failed = result.checks.filter((check) => !check.ok).map((check) => check.label);
  assert.ok(failed.some((label) => label.includes('字节数')), `失败项里要有字节数，实际：${failed.join(',')}`);
  assert.ok(failed.some((label) => label.includes('实体数')), `失败项里要有实体数，实际：${failed.join(',')}`);
  assert.ok(failed.some((label) => label.includes('面数')), `失败项里要有面数，实际：${failed.join(',')}`);
  assert.equal(result.checks.find((check) => check.label.includes('包络'))?.ok, true);
  assert.equal(inspection.bytes < STEP_MIN_BYTES, true);
});

test('checkStepExport：真 STEP 的形态（6000×1495×930 / 89 实体 / 1.9 MB）应全过', () => {
  // 用真机导出的关键数字造一份「合规」形态，验证阈值本身没写反
  const inspection = {
    ...inspectStep(twoBoxStep()),
    bytes: 1_930_948,
    solids: 89,
    shells: 89,
    faces: 613
  };
  const result = checkStepExport(inspection, { parts: 85, envelopeMm: [6000, 1495, 930] });
  // 包络这条按手写件（600×100×10）算，必然不过；其余必须过
  const others = result.checks.filter((check) => !check.label.includes('包络'));
  assert.equal(others.every((check) => check.ok), true);
  assert.equal(result.checks.find((check) => check.label.includes('包络'))?.ok, false);
});

test('checkStepExport：实体数容差 ±5 —— 84/90 过，79/91 挂', () => {
  const base = { ...inspectStep(twoBoxStep()), bytes: 2_000_000, faces: 900 };
  const verdict = (solids) => checkStepExport({ ...base, solids }, { parts: 85, envelopeMm: [600, 100, 10] }).ok;
  assert.equal(verdict(80), true);
  assert.equal(verdict(84), true);
  assert.equal(verdict(85), true);
  assert.equal(verdict(90), true);
  assert.equal(verdict(79), false);
  assert.equal(verdict(91), false);
});

test('checkStepExport：包络逐轴 ±40mm —— 差 30 过，差 60 挂', () => {
  const base = { ...inspectStep(twoBoxStep()), bytes: 2_000_000, solids: 85, faces: 900 };
  const verdict = (lengthMm) =>
    checkStepExport({ ...base, bbox: { min: [0, 0, 0], max: [lengthMm, 100, 10], size: [lengthMm, 100, 10] } }, {
      parts: 85,
      envelopeMm: [600, 100, 10]
    }).ok;
  assert.equal(verdict(630), true);
  assert.equal(verdict(660), false);
  assert.equal(verdict(570), true);
  assert.equal(verdict(540), false);
});

test('回归：`verify:step --file` 传 3 KB 假 STEP 必须 exit 1（CLI 真的会红）', () => {
  const script = fileURLToPath(new URL('../../scripts/verify-step-export.mjs', import.meta.url));
  const run = spawnSync(process.execPath, [script, '--file', fixture('step-stub-3kb.step')], {
    encoding: 'utf8',
    timeout: 60_000
  });
  assert.equal(run.status, 1, `退出码应为 1，实际 ${run.status}\n${run.stdout}`);
  assert.match(run.stdout, /STEP_VERIFY FAIL 字节数/);
  assert.match(run.stdout, /STEP_VERIFY FAIL 实体数/);
  assert.match(run.stdout, /file-check \d+\/6/);
});

test('回归：`verify:step --file` 传不存在的路径不算「通过」（exit 2）', () => {
  const script = fileURLToPath(new URL('../../scripts/verify-step-export.mjs', import.meta.url));
  const run = spawnSync(process.execPath, [script, '--file', fixture('nope.step')], { encoding: 'utf8', timeout: 60_000 });
  assert.equal(run.status, 2, `退出码应为 2，实际 ${run.status}`);
  assert.match(run.stdout + run.stderr, /文件不存在/);
});

test('describeInspection：一行里带得齐字节/实体/面/包络/单位', () => {
  const line = describeInspection(inspectStep(twoBoxStep()));
  assert.match(line, /bytes=\d+/);
  assert.match(line, /solids=2/);
  assert.match(line, /faces=8/);
  assert.match(line, /bbox=600\.0×100\.0×10\.0/);
  assert.match(line, /units=MM/);
});
