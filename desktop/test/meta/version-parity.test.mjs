// 版本号单一来源 + Qt 侧「node 直写」守卫。
//
// 事故背景：qt-client/CMakeLists.txt 写 0.5.0、desktop/package.json 是 0.5.1、
// ci.yml 断言 0.5.1 —— 三处不一致却一直绿，因为 Qt 是 GUI 子系统程序，打包核对那步
// 拿不到 stdout 就按「无输出」跳过版本断言。漂移于是没人发现：安装包里的 exe --version
// 和桌面端显示的版本对不上。
//
// 这条测试把四处（package.json / CMakeLists / ci.yml / README）拉到一起断言相等，
// 另外守住 Qt 侧不再出现 `QStringLiteral("node")` 的直写 —— 安装态客户机没有 Node，
// 运行时必须走 resolveNodeRunner()（优先 Electron 的 ELECTRON_RUN_AS_NODE）。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

// 相对于本文件：desktop/test/meta/ → ../../ = desktop/，../../../ = 仓库根
const PKG = { display: 'desktop/package.json', text: read('../../package.json') };
const CMAKE = { display: 'qt-client/CMakeLists.txt', text: read('../../../qt-client/CMakeLists.txt') };
const CI = { display: '.github/workflows/ci.yml', text: read('../../../.github/workflows/ci.yml') };
const README = { display: 'README.md', text: read('../../../README.md') };
const MAINWINDOW = { display: 'qt-client/src/MainWindow.cpp', text: read('../../../qt-client/src/MainWindow.cpp') };

const VERSION_RE = /^\d+\.\d+\.\d+$/;

/** package.json 的 version 字段。 */
function packageVersion(text) {
  const pkg = JSON.parse(text);
  return typeof pkg.version === 'string' ? pkg.version : '';
}

/** CMake 的 project(... VERSION x.y.z ...)。 */
function cmakeVersion(text) {
  const m = /project\s*\(\s*AutomationCAD-QtClient\s+VERSION\s+(\d+\.\d+\.\d+)/.exec(text);
  return m ? m[1] : '';
}

/**
 * ci.yml 里所有「版本断言」的取值：`Write-Host "... version=0.5.1"` 这类日志行
 * 和 `-notmatch "0\.5\.1"` 这类正则断言都要一致。返回去重后的集合。
 */
function ciVersions(text) {
  const found = new Set();
  for (const m of text.matchAll(/\bversion=(\d+\.\d+\.\d+)\b/g)) found.add(m[1]);
  for (const m of text.matchAll(/-notmatch\s+"(\d+)\\?\.(\d+)\\?\.(\d+)"/g)) found.add(`${m[1]}.${m[2]}.${m[3]}`);
  return [...found].sort();
}

/** README 的「当前版本：**v0.5.1**」。 */
function readmeVersion(text) {
  const m = /当前版本：\*\*v(\d+\.\d+\.\d+)\*\*/.exec(text);
  return m ? m[1] : '';
}

test('版本号四处一致：package.json = CMakeLists = ci.yml = README', () => {
  const pkg = packageVersion(PKG.text);
  const cmake = cmakeVersion(CMAKE.text);
  const ci = ciVersions(CI.text);
  const readme = readmeVersion(README.text);

  // 先证明解析器真的取到了值：正则写歪时下面几条 assert 会在「空字符串相等」上空转。
  for (const [name, value] of [['package.json', pkg], ['CMakeLists.txt', cmake], ['README.md', readme]]) {
    assert.match(value, VERSION_RE, `${name} 里没解析出版本号（解析规则失效？）`);
  }
  assert.ok(ci.length > 0, 'ci.yml 里没找到任何版本断言（解析规则失效，或被整段删掉了）');

  assert.equal(cmake, pkg, `qt-client/CMakeLists.txt 的 project VERSION ${cmake} 与 desktop/package.json ${pkg} 不一致`);
  assert.equal(readme, pkg, `README 的「当前版本 v${readme}」与 desktop/package.json ${pkg} 不一致`);
  assert.deepEqual(ci, [pkg], `ci.yml 的版本断言 ${ci.join(', ')} 与 desktop/package.json ${pkg} 不一致（GUI 子系统吞 stdout 时这步会被跳过，所以靠这条测试兜住）`);
});

test('自证：版本解析器对不一致样本必须报错（防止断言空转）', () => {
  // 把真文件里的版本替换成别的值，解析结果必须跟着变 —— 否则说明正则匹配的是别处。
  const bumped = PKG.text.replace(/"version"\s*:\s*"[^"]*"/, '"version": "9.9.9"');
  assert.equal(packageVersion(bumped), '9.9.9');
  assert.notEqual(cmakeVersion(CMAKE.text), '9.9.9');
  assert.equal(readmeVersion('README 一行都没有版本号'), '');
  assert.deepEqual(ciVersions('Write-Host "OCCT_WIN_RUN_OK version=0.5.1"'), ['0.5.1']);
  assert.deepEqual(ciVersions('-notmatch "0\\.5\\.1"'), ['0.5.1']);
});

/** 去掉整行注释和行尾注释后的代码行（注释里提到 node 字面量不算违规）。 */
function codeLines(text) {
  const out = [];
  let inBlock = false;
  text.split('\n').forEach((line, index) => {
    const trimmed = line.trim();
    if (inBlock) {
      if (trimmed.includes('*/')) inBlock = false;
      out.push({ lineNo: index + 1, text: '' });
      return;
    }
    if (trimmed.startsWith('/*')) {
      if (!trimmed.includes('*/')) inBlock = true;
      out.push({ lineNo: index + 1, text: '' });
      return;
    }
    if (trimmed.startsWith('//')) {
      out.push({ lineNo: index + 1, text: '' });
      return;
    }
    out.push({ lineNo: index + 1, text: line.replace(/\/\/.*$/, '') });
  });
  return out;
}

const SPAWN_LITERAL_RE = /start\s*\(\s*QStringLiteral\s*\(\s*"node"\s*\)/;

test('Qt 侧没有 QStringLiteral("node") 直写：四处 spawn 全走 resolveNodeRunner()', () => {
  const lines = codeLines(MAINWINDOW.text);

  // ① 不允许直接把 "node" 当成启动目标
  const directSpawns = lines.filter((line) => SPAWN_LITERAL_RE.test(line.text));
  assert.deepEqual(
    directSpawns.map((line) => line.lineNo),
    [],
    'MainWindow.cpp 里还有 process.start(QStringLiteral("node"), ...) 直写；安装态客户机没有 Node，必须走 resolveNodeRunner()',
  );

  // ② 所有 process.start 的第一个实参都必须是解析出来的 program
  const starts = [...MAINWINDOW.text.matchAll(/process\.start\s*\(\s*([A-Za-z_][\w.]*)/g)].map((m) => m[1]);
  assert.equal(starts.length, 4, `process.start 应当恰好四处（designMachine / PLC 体检 / 联动 / 构件库），实际 ${starts.length} 处`);
  assert.deepEqual(starts.filter((program) => program !== 'node.program'), [], '存在未走 node.program 的 spawn');

  // ③ 每次 spawn 前都要注入 ELECTRON_RUN_AS_NODE（漏了会拉起整个 GUI 主窗口）
  const prepared = MAINWINDOW.text.match(/prepareNodeProcess\(process, node\)/g) ?? [];
  assert.equal(prepared.length, 4, '四处 spawn 都必须先 prepareNodeProcess(process, node)');

  // ④ 剩下的 "node" 字面量只允许出现在 resolveNodeRunner() 体内（PATH 兜底那一处）
  const headLine = lines.find((line) => line.text.includes('NodeRunner resolveNodeRunner()'))?.lineNo ?? -1;
  const tailLine = lines.find((line) => line.text.includes('void prepareNodeProcess'))?.lineNo ?? -1;
  assert.ok(headLine > 0 && tailLine > headLine, '找不到 resolveNodeRunner() 的函数边界，本测试的定位逻辑失效了');
  const strays = lines.filter(
    (line) => line.text.includes('QStringLiteral("node")') && (line.lineNo < headLine || line.lineNo > tailLine),
  );
  assert.deepEqual(
    strays.map((line) => line.lineNo),
    [],
    'QStringLiteral("node") 只允许出现在 resolveNodeRunner() 的 PATH 兜底里',
  );
});

test('自证：直写检测器能抓到违规样本，且不误报合规写法', () => {
  assert.equal(SPAWN_LITERAL_RE.test('    process.start(QStringLiteral("node"), arguments);'), true);
  assert.equal(SPAWN_LITERAL_RE.test('    process.start(node.program, arguments);'), false);
  assert.equal(
    codeLines('    // 旧写法：process.start(QStringLiteral("node"))').filter((l) => SPAWN_LITERAL_RE.test(l.text)).length,
    0,
    '整行注释里的旧写法不该被判违规',
  );
});

test('管线脚本解析顺序：AUTOMATIONCAD_PIPELINE → 随包 cjs → 源码 mjs', () => {
  const text = MAINWINDOW.text;
  const env = text.indexOf('AUTOMATIONCAD_PIPELINE');
  const bundled = text.indexOf('../pipeline/machine-design-cli.cjs');
  const source = text.indexOf('desktop/scripts/machine-design-cli.mjs');
  assert.ok(env > 0, '找不到 AUTOMATIONCAD_PIPELINE 分支');
  assert.ok(bundled > 0, '找不到随包 cjs（resources/pipeline/machine-design-cli.cjs）的探测分支');
  assert.ok(source > 0, '找不到开发态源码兜底（desktop/scripts/machine-design-cli.mjs）');
  assert.ok(env < bundled, '环境变量必须排在最前（显式配置优先）');
  assert.ok(bundled < source, '随包 cjs 必须排在源码 mjs 之前：安装包里没有 desktop/scripts/');

  // 失败文案要能自己讲清楚：给出「找过的路径」+ 该确认哪个目录
  assert.match(text, /找过的路径/, '脚本/运行时失败文案缺少「找过的路径」清单');
  assert.match(text, /请在安装目录确认 resources\/qt 与 resources\/pipeline 是否存在/, '脚本失败文案缺少安装目录自检提示');
});
