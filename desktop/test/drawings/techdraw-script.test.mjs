// FreeCAD 侧脚本：普通 python3 下跑纯逻辑自检（图幅/比例/布局/DXF 句柄追加/SVG 合成）；
// 设置 AUTOMATIONCAD_FREECAD_REAL=<freecadcmd 路径> 时再用真 FreeCAD 端到端出一张图。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { TECHDRAW_SCRIPT_VERSION, DRAWING_JOB_PROTOCOL, DRAWING_RESULT_PROTOCOL, DRAWING_PROGRESS_PREFIX } from '../../src/drawings/protocol.ts';

const SCRIPT = fileURLToPath(new URL('../../../spike/freecad/techdraw_job.py', import.meta.url));

function findPython() {
  for (const name of ['python3', 'python']) {
    const probe = spawnSync(name, ['-c', 'import sys;print(sys.version_info[0])'], { encoding: 'utf8' });
    if (probe.status === 0 && probe.stdout.trim() === '3') return name;
  }
  return null;
}

const python = findPython();

test('脚本与 TS 协议常量一致（版本、协议名、进度前缀）', () => {
  const source = readFileSync(SCRIPT, 'utf8');
  assert.match(source, new RegExp(`SCRIPT_VERSION = "${TECHDRAW_SCRIPT_VERSION.replace(/\./g, '\\.')}"`));
  assert.ok(source.includes(`PROTOCOL = "${DRAWING_JOB_PROTOCOL}"`));
  assert.ok(source.includes(`RESULT_PROTOCOL = "${DRAWING_RESULT_PROTOCOL}"`));
  assert.ok(source.includes(`EVENT_PREFIX = "${DRAWING_PROGRESS_PREFIX}"`));
  assert.ok(source.includes('"First Angle"'), '第一角投影');
  assert.ok(!/^\s*(import|from)\s+build123d/m.test(source), '不得在 FreeCAD 进程里 import build123d');
  assert.ok(!/^\s*(import|from)\s+(A2plus|a2p)/m.test(source), '不依赖第三方工作台');
});

test('python3 纯逻辑自检（无 FreeCAD）', { skip: python ? false : '沙箱无 python3' }, () => {
  const run = spawnSync(python, [SCRIPT, '--self-test'], { encoding: 'utf8', timeout: 60_000 });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /SELF_TEST_OK/);
});

test('python3 语法检查', { skip: python ? false : '沙箱无 python3' }, () => {
  const run = spawnSync(python, ['-m', 'py_compile', SCRIPT], { encoding: 'utf8', timeout: 60_000, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONPYCACHEPREFIX: tmpdir() } });
  assert.equal(run.status, 0, run.stderr);
});

const realFreecad = process.env.AUTOMATIONCAD_FREECAD_REAL;
test('真 FreeCAD 自带 Python 跑同一套自检（--pass --self-test，确认不是只打印帮助）', { skip: realFreecad && existsSync(realFreecad) ? false : '未设置 AUTOMATIONCAD_FREECAD_REAL' }, () => {
  const run = spawnSync(realFreecad, [SCRIPT, '--pass', '--self-test'], { encoding: 'utf8', timeout: 120_000 });
  assert.match(run.stdout + run.stderr, /SELF_TEST_OK/);
  assert.doesNotMatch(run.stdout, /--safe-mode/, '不应落到 freecadcmd 的帮助输出');
});

test('脚本自检入口：freecadcmd 下 __name__ 非 __main__ 时 --self-test 参数也能触发', () => {
  const source = readFileSync(SCRIPT, 'utf8');
  // Windows 检出（autocrlf / 编辑器保存）会是 CRLF，行尾必须兼容，否则断言在 win 上必然失败。
  // 语义不变：仍要求 `"--self-test" in sys.argv:` 独占一整行（后面紧跟换行，不是子串）。
  assert.match(source.replace(/\r\n/g, '\n'), /"--self-test" in sys\.argv:\n/);
  assert.ok(source.includes('--pass --self-test'));
});

test('真 FreeCAD 端到端（AUTOMATIONCAD_FREECAD_REAL）', { skip: realFreecad && existsSync(realFreecad) ? false : '未设置 AUTOMATIONCAD_FREECAD_REAL' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'acad-real-freecad-'));
  try {
    // 最小 STEP：用 FreeCAD 自己造一个盒子导出（不依赖 build123d）
    const makeStep = join(root, 'make.py');
    const step = join(root, 'box.step');
    writeFileSync(makeStep, `import Part\nPart.makeBox(120, 60, 20).exportStep(${JSON.stringify(step)})\n`);
    spawnSync(realFreecad, [makeStep], { encoding: 'utf8', timeout: 120_000 });
    assert.ok(existsSync(step), 'STEP 已生成');
    const out = join(root, 'out');
    const jobPath = join(root, 'job.json');
    writeFileSync(jobPath, JSON.stringify({
      protocol: DRAWING_JOB_PROTOCOL, jobId: 'fc-real-0001', kind: 'techdraw', outputDir: out,
      options: { formats: ['pdf', 'dxf', 'svg'], paper: 'auto', scale: 'auto', iso: true, hiddenLines: true, hlrTimeoutSec: 60 },
      titleBlock: { designer: 'test', company: '', date: '2026-10-26' },
      parts: [{ partId: 'BOX', fileStem: 'BOX-00000000', name: '盒子', material: 'Q235', drawingNo: 'T-1', quantity: 1, step }]
    }));
    const run = spawnSync(realFreecad, [SCRIPT], { encoding: 'utf8', timeout: 180_000, env: { ...process.env, AUTOMATIONCAD_FREECAD_JOB: jobPath } });
    const result = JSON.parse(readFileSync(join(out, 'result.json'), 'utf8'));
    assert.equal(result.ok, true, JSON.stringify(result) + run.stderr);
    assert.ok(existsSync(join(out, 'BOX-00000000.pdf')));
    assert.ok(existsSync(join(out, 'BOX-00000000.dxf')));
    assert.deepEqual(result.parts[0].dimensions, { length: 120, width: 60, height: 20 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
