// Windows Qt + OCCT 打包段的静态断言：直接读真实 .github/workflows/ci.yml，不把流水线脚本
// 硬编码进测试。目的：桌面端跑 `node --test` 就能发现「依赖 DLL 只打印不复制 / STL 库漏进包 /
// STEP 库改名后静默跳过 / 砍掉 VC 运行库 / tbb 写死 soname / occt 版本没 pin / 缺库仍然全绿」
// 这几类回归。
// 每条守卫都带负向自证：把对应代码从文本里删掉，判定函数必须返回 false，防止断言空转。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const CI_URL = new URL('../../.github/workflows/ci.yml', import.meta.url);
const CI = readFileSync(CI_URL, 'utf8');
const CI_PATH_DISPLAY = '.github/workflows/ci.yml';

// 第三方运行库：OCCT/Qt 在纯净 Windows 机上真正需要的同名 DLL。
// tbb 不在这个名单里 —— 它的 DLL 名带 soname（tbb12 → tbb13），只能按 tbb*.dll 通配守（见 ⑧）。
const REQUIRED_DEPS = ['FreeImage', 'freetype', 'zlib', 'libpng16'];
// 核心 OCCT 库：缺一个都不许静默跳过（视口、布尔、B-Rep 都靠它们）。
const REQUIRED_CORE = ['TKernel', 'TKMath', 'TKG3d', 'TKBRep', 'TKTopAlgo', 'TKBO', 'TKService', 'TKV3d', 'TKOpenGl'];
// OCCT 8.0.1 的传递依赖：qt-client 不直接链它们，但 TKV3d 静态导入 TKMesh/TKHLR，
// TKDESTEP/TKDESTL 静态导入 TKDE/TKXCAF/TKLCAF/TKCAF/TKVCAF/TKCDF。缺任一的现象最难查 ——
// exe --version 正常、启动核对也全绿，客户机上点视口或导 STEP 才 0xc0000135。
// 同名 DLL 在 conda-forge occt-8.0.1-novtk_h6bfc850_101 的 Library/bin 下逐个实查存在（8/8）。
const REQUIRED_TRANSITIVE = [
  'TKMesh', 'TKHLR',                                  // TKV3d 的静态导入
  'TKDE', 'TKXCAF', 'TKLCAF', 'TKCAF', 'TKVCAF', 'TKCDF', // TKDESTEP / TKDESTL 的静态导入
];

/** 取某个 step（按 name 片段匹配）在 ci.yml 里的完整文本块。 */
function stepBlock(lines, nameNeedle) {
  const stepRe = /^(\s*)-\s+name:\s*(.+?)\s*$/;
  for (let i = 0; i < lines.length; i += 1) {
    const m = stepRe.exec(lines[i]);
    if (!m || !m[2].includes(nameNeedle)) continue;
    const dashIndent = m[1].length;
    let end = lines.length;
    for (let j = i + 1; j < lines.length; j += 1) {
      const next = stepRe.exec(lines[j]);
      if (next && next[1].length === dashIndent) {
        end = j;
        break;
      }
      // 缩进比 step 的 "- " 还浅 → 已经出了这个 job / step 列表。
      const lead = lines[j].length - lines[j].trimStart().length;
      if (lines[j].trim() && lead < dashIndent) {
        end = j;
        break;
      }
    }
    return lines.slice(i, end).join('\n');
  }
  return null;
}

/**
 * 从 openIdx（指向 '{'）开始做括号配平，返回块内文本。
 * PowerShell 的字符串与注释里都会出现 `{` / `}`（`"a{b}c"`、`"${x}"`、`'}'`、`# {`），
 * 朴素计数会在字符串内部提前收尾（切出半截块，或误报「大括号不配平」），
 * 所以先跳过单引号、双引号（含 ` 转义与 '' "" 双写转义）、# 行注释、<# #> 块注释，再计数。
 * 已知边界：不解析 "$(...)" 子表达式里的嵌套代码，够这个打包段用。
 */
function braceBody(text, openIdx) {
  assert.equal(text[openIdx], '{', '括号配平入口必须是 {');
  let depth = 0;
  for (let i = openIdx; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '<' && text[i + 1] === '#') {
      const close = text.indexOf('#>', i + 2);
      if (close < 0) assert.fail('块注释 <# 没有闭合');
      i = close + 1;
      continue;
    }
    if (ch === '#') {
      const nl = text.indexOf('\n', i);
      if (nl < 0) break;
      i = nl;
      continue;
    }
    if (ch === "'" || ch === '"') {
      const quote = ch;
      for (i += 1; i < text.length; i += 1) {
        if (quote === '"' && text[i] === '`') { i += 1; continue; }   // 反引号转义下一个字符
        if (text[i] === quote) {
          if (text[i + 1] === quote) { i += 1; continue; }            // '' / "" 双写转义
          break;
        }
      }
      continue;   // 收尾引号由外层 for 的 i += 1 跳过
    }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(openIdx + 1, i);
    }
  }
  assert.fail('大括号不配平，无法静态解析该块');
}

/** 找到匹配 headRe 的那段 `... {`，返回循环/分支体文本。 */
function bodyOf(text, headRe, label) {
  const m = headRe.exec(text);
  assert.ok(m, `打包段里没找到 ${label}`);
  const openIdx = text.indexOf('{', m.index + m[0].length - 1);
  assert.ok(openIdx > 0, `${label} 后面没有 {`);
  return braceBody(text, openIdx);
}

/** `$var = @('a','b')` 形式数组的字符串元素。 */
function arrayLiteral(text, varName) {
  const m = new RegExp(`\\$${varName}\\s*=\\s*@\\(([\\s\\S]*?)\\)`).exec(text);
  assert.ok(m, `打包段里没找到 $${varName} 的数组定义`);
  return m[1];
}

/**
 * $keep 白名单里缺哪些库：返回缺失名单（空数组 = 齐）。
 * 既给正面断言用，也给负向自证用（喂一份删掉某个名字的文本必须返回非空）。
 */
function missingKeepLibs(text, libs) {
  let keep;
  try {
    keep = arrayLiteral(text, 'keep');
  } catch {
    return [...libs];   // 连 $keep 都找不到，全算缺
  }
  return libs.filter((lib) => !new RegExp(`['"]${lib}['"]`).test(keep));
}

const LINES = CI.split('\n');
const PACKAGING = stepBlock(LINES, 'windeployqt + OCCT DLL');

// ---------------------------------------------------------------------------
// 守卫判定函数：既给正面断言用，也给负向自证用（喂一份被删改的文本必须返回 false）。
// 只吃文本、不读全局，所以可以对内存里变异过的副本求值。
// ---------------------------------------------------------------------------

/** ⑤ STL 候选数组 + 真复制 + 落地回验 + 一个都没命中就 throw。 */
function hasStlGuard(text) {
  try {
    const arr = arrayLiteral(text, 'stlCandidates');
    if (!/['"]TKSTL['"]/.test(arr) || !/['"]TKDESTL['"]/.test(arr)) return false;
    const loop = bodyOf(text, /foreach\s*\(\s*\$name\s+in\s+\$stlCandidates\s*\)\s*\{/, 'STL 候选循环');
    if (!/Copy-Item\s+\$file\s+\$dist/.test(loop)) return false;
    if (!/Test-Path\s*\(\s*Join-Path\s+\$dist\s+"\$name\.dll"\s*\)/.test(loop)) return false;
    const guard = bodyOf(text, /if\s*\(\s*\$stlCopied\.Count\s+-eq\s+0\s*\)\s*\{/, 'STL 缺库守卫');
    return /throw/.test(guard);
  } catch {
    return false;   // 找不到数组/循环/守卫本身就是不合格
  }
}

/**
 * ③-a VC++ 运行库必须「从 VS 的 CRT 可再分发目录主动拷」进 $dist。
 * 只断言 windeployqt 带开关是不够的：实测 windeployqt 6.8.3 在 windows-latest 上
 * 只丢 vc_redist.x64.exe，三个 CRT DLL 一个不放（run 41317009763）。
 */
function hasVcRuntimeCopy(text) {
  try {
    // 目录发现三件套：环境变量优先，glob 与 vswhere 兜底，最终都落到 x64\Microsoft.VC*.CRT。
    // 断言都卡在「代码形状」上，不认注释里的同一句话。
    if (!/if\s*\(\s*\$env:VCToolsRedistDir\s*\)/.test(text)) return false;
    if (!/-Filter\s+'Microsoft\.VC\*\.CRT'/.test(text)) return false;
    if (!/vswhere[\s\S]*-requires\s+Microsoft\.VisualStudio\.Component\.VC\.Tools\.x86\.x64/.test(text)) return false;
    if (!/Join-Path\s+\$root\s+'x64'/.test(text)) return false;
    const arr = arrayLiteral(text, 'vcRuntime');
    for (const rt of ['vcruntime140.dll', 'vcruntime140_1.dll', 'msvcp140.dll']) {
      if (!arr.includes(`'${rt}'`) && !arr.includes(`"${rt}"`)) return false;
    }
    // 真的 Copy-Item 进 $dist，并且回验落地、打印 VC_RUNTIME_COPIED（不是只 Write-Host 源路径）。
    const loop = bodyOf(text, /foreach\s*\(\s*\$rt\s+in\s+\$vcRuntime\s*\)\s*\{/, 'CRT DLL 拷贝循环');
    if (!/Copy-Item\s+\$src\s+\$dist/.test(loop)) return false;
    if (!/Test-Path\s*\(\s*Join-Path\s+\$dist\s+\$rt\s*\)/.test(loop)) return false;
    if (!/VC_RUNTIME_COPIED/.test(loop)) return false;
    // 必须在 windeployqt 之后跑：先部署再用 CRT 目录里的真 DLL 覆盖，顺序反了会被覆盖回去。
    const lines = text.split('\n');
    const deployAt = lines.findIndex((l) => /^\s*windeployqt(\s|$)/.test(l));
    const copyAt = lines.findIndex((l) => /^\s*\$vcRuntime\s*=\s*@\(/.test(l));
    return deployAt >= 0 && copyAt > deployAt;
  } catch {
    return false;
  }
}

/**
 * ③-b 守卫必须是三档，而不是「缺一个就 throw」：
 *   三件都到位 → VC_RUNTIME_OK；没全到但有 vc_redist.x64.exe → VC_RUNTIME_REDIST_ONLY 且不抛；
 *   两者都没有 → throw（且报错里带 $vcMissing 与 vc_redist）。
 */
function hasVcRuntimeGuard(text) {
  try {
    const arr = arrayLiteral(text, 'vcRuntime');
    for (const rt of ['vcruntime140.dll', 'vcruntime140_1.dll', 'msvcp140.dll']) {
      if (!arr.includes(`'${rt}'`) && !arr.includes(`"${rt}"`)) return false;
    }
    const loop = bodyOf(text, /foreach\s*\(\s*\$name\s+in\s+\$vcRuntime\s*\)\s*\{/, '运行库落盘回验循环');
    if (!/Test-Path\s*\(\s*Join-Path\s+\$dist\s+\$name\s*\)/.test(loop)) return false;
    if (!/\$vcMissing\s*\+=/.test(loop)) return false;
    if (/throw/.test(loop)) return false;   // 单个 DLL 缺失就直接 throw = 误红的老写法

    const ok = bodyOf(text, /if\s*\(\s*\$vcMissing\.Count\s+-eq\s+0\s*\)\s*\{/, '三件齐备分支');
    if (!/VC_RUNTIME_OK/.test(ok)) return false;

    const redist = bodyOf(text, /elseif\s*\(\s*Test-Path\s+\$vcRedist\s*\)\s*\{/, 'vc_redist 兜底分支');
    if (!/VC_RUNTIME_REDIST_ONLY/.test(redist)) return false;
    if (/throw/.test(redist)) return false;   // 包里有安装器就放行，这是本用例要保的行为

    const fatal = bodyOf(text,
      /elseif\s*\(\s*Test-Path\s+\$vcRedist\s*\)\s*\{[\s\S]*?\}\s*else\s*\{/, '两者都缺的 throw 分支');
    return /throw/.test(fatal) && /\$vcMissing/.test(fatal) && /vc_redist/.test(fatal);
  } catch {
    return false;
  }
}

/** ⑥ 第三方依赖：freetype/libpng16/zlib 硬依赖缺则 throw，且「一个都没复制到」也要 throw。 */
function hasHardDepGuard(text) {
  try {
    const req = arrayLiteral(text, 'depsRequired');
    for (const dep of ['freetype.dll', 'libpng16.dll', 'zlib.dll']) {
      if (!req.includes(`'${dep}'`) && !req.includes(`"${dep}"`)) return false;
    }
    const loop = bodyOf(text, /foreach\s*\(\s*\$dep\s+in\s+\$deps\s*\)\s*\{/, '$deps 复制循环');
    if (!/\$depsRequired\s+-contains\s+\$dep/.test(loop)) return false;
    if (!/\$depsRequiredMissing\s*\+=/.test(loop)) return false;
    const hardGuard = bodyOf(text, /if\s*\(\s*\$depsRequiredMissing\.Count\s+-gt\s+0\s*\)\s*\{/,
      '第三方硬依赖缺库守卫');
    if (!/throw/.test(hardGuard) || !/\$depsRequiredMissing/.test(hardGuard)) return false;
    const zeroGuard = bodyOf(text, /if\s*\(\s*\$depsCopied\s+-eq\s+0\s*\)\s*\{/, '依赖全缺守卫');
    return /throw/.test(zeroGuard);
  } catch {
    return false;
  }
}

test('打包 step 存在且被正确解析（防止空断言通过）', () => {
  assert.ok(PACKAGING, `${CI_PATH_DISPLAY} 里找不到「打包（windeployqt …）」step`);
  assert.ok(PACKAGING.length > 800, `打包段太短（${PACKAGING.length} 字符），解析可能错位`);
  assert.match(PACKAGING, /windeployqt/, '打包段必须调用 windeployqt');
  assert.match(PACKAGING, /Compress-Archive[\s\S]*automationcad-qt-windows-x64-occt\.zip/,
    '产物压缩与命名必须保持不变');
});

test('① 第三方依赖 DLL 必须真实 Copy-Item 进 $dist（不是只 Write-Host）', () => {
  const depsInArray = arrayLiteral(PACKAGING, 'deps');
  for (const dep of REQUIRED_DEPS) {
    assert.match(depsInArray, new RegExp(`['"]${dep}\\.dll['"]`),
      `$deps 数组里缺 ${dep}.dll`);
  }
  // tbb 不许回到固定名：写死 tbb12.dll 的结果是「上游升到 tbb13 → 全不命中 → 只告警 → 包缺 tbb 却全绿」。
  assert.doesNotMatch(depsInArray, /tbb/i,
    '$deps 里又写死了 tbb 的名字：必须走 tbb*.dll 通配（见 ⑧）');
  // 遍历 $deps 的循环体里必须真的有复制动作，且复制源是遍历出来的依赖。
  const loop = bodyOf(PACKAGING, /foreach\s*\(\s*\$dep\s+in\s+\$deps\s*\)\s*\{/, '$deps 复制循环');
  assert.match(loop, /Copy-Item\s+\$src\s+\$dist/, '$deps 循环里没有 Copy-Item $src $dist（只打印不算）');
  assert.match(loop, /Test-Path\s*\(\s*Join-Path\s+\$dist\s+\$dep\s*\)/,
    '$deps 循环必须回验依赖确实落进 $dist');
  assert.doesNotMatch(loop, /Write-Host[^\n]*DEP_PRESENT/,
    '循环里只剩 Write-Host DEP_PRESENT（旧的「只打印」实现）');
  assert.doesNotMatch(PACKAGING, /DEP_PRESENT/, '打包段还在用只打印的 DEP_PRESENT 判定');
});

test('② STEP 交换库兼容 TKDE/TKDESTEP/TKXDESTEP 与 TKSTEP*，且一个都没匹配到就 throw', () => {
  const candidates = arrayLiteral(PACKAGING, 'stepCandidates');
  for (const name of ['TKXDESTEP', 'TKDESTEP', 'TKDE', 'TKSTEP', 'TKSTEPBase']) {
    assert.ok(new RegExp(`['"]${name}['"]`).test(candidates),
      `$stepCandidates 候选数组里缺 ${name}（STEPCAFControl_Reader 需要 TKXDESTEP）`);
  }

  // 候选列表里的每个名字都要 Copy-Item，而不是只列出来。
  const stepLoop = bodyOf(PACKAGING, /foreach\s*\(\s*\$name\s+in\s+\$stepCandidates\s*\)\s*\{/,
    'STEP 库复制循环');
  assert.match(stepLoop, /Copy-Item/, 'STEP 候选循环里没有 Copy-Item');

  // 全部落空 → 必须 throw，不许静默过。
  const guard = bodyOf(PACKAGING, /if\s*\(\s*\$stepCopied\.Count\s+-eq\s+0\s*\)\s*\{/, 'STEP 缺库守卫');
  assert.match(guard, /throw/, 'STEP 库一个都没匹配到时必须 throw');
});

/** 打包段里真正执行的那条 windeployqt 命令行（排除注释与 step 名）。 */
function deployLineOf(text) {
  return text.split('\n').find((l) => /^\s*windeployqt(\s|$)/.test(l)) ?? '';
}

/** 命令行是否仍然剔除 VC++ 运行库。 */
function dropsCompilerRuntime(text) {
  return /--no-compiler-runtime/.test(deployLineOf(text));
}

test('③ 去掉 --no-compiler-runtime 必须与「VC++ 运行库真落地」绑在一起', () => {
  const deployLine = deployLineOf(PACKAGING);
  assert.ok(deployLine, '找不到 windeployqt 调用行');
  assert.doesNotMatch(deployLine, /--no-compiler-runtime/,
    'windeployqt 仍带 --no-compiler-runtime：VC++ 运行库会被剔除，纯净 Windows 机缺 VCRUNTIME140_1.dll');
  assert.match(deployLine, /automationcad-qt\.exe/, 'windeployqt 必须指向打包目录里的 exe');
  // 注释里可以提到这个开关（方便 grep 历史原因），但真正执行的命令行里一处都不许有。
  const executable = CI.split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n');
  assert.doesNotMatch(executable, /--no-compiler-runtime/,
    `${CI_PATH_DISPLAY} 的可执行命令行里仍出现 --no-compiler-runtime`);

  // 绑定点 1：光去掉开关只是「允许它带」。windeployqt 6.8.3 在 windows-latest 上实测只丢
  // vc_redist 安装器（+18MB）而不放 DLL（run 41317009763），所以必须主动从 VS 的 CRT
  // 可再分发目录把 vcruntime140/140_1/msvcp140 拷进 $dist。
  assert.ok(hasVcRuntimeCopy(PACKAGING),
    'windeployqt 之后没有「从 VS CRT 目录拷 DLL」的逻辑：需要 $env:VCToolsRedistDir / '
    + 'Microsoft.VC*.CRT 目录发现 + 逐个 Copy-Item 进 $dist + Test-Path 回验 + VC_RUNTIME_COPIED');
  // 绑定点 2：缺一个就 throw 的守卫在「windeployqt 只给安装器」的 runner 上必然误红，
  // 必须改成三档（三件齐 → 绿 / 只有 vc_redist → 告警 / 都没有 → throw）。
  assert.ok(hasVcRuntimeGuard(PACKAGING),
    'VC++ 运行库守卫不是三档：需要「三件齐 → VC_RUNTIME_OK；缺但包内有 vc_redist.x64.exe → '
    + 'VC_RUNTIME_REDIST_ONLY 不抛；两者都没有 → throw」');
  assert.match(PACKAGING, /VC_RUNTIME_REDIST_ONLY/,
    '打包段没有 VC_RUNTIME_REDIST_ONLY 告警分支：只有 vc_redist 安装器时会被误判成红');

  // 负向自证 1：把运行库数组删掉 → 两个判定都必须变红（证明断言不是空转）。
  const noRuntime = PACKAGING.replace(/\$vcRuntime\s*=\s*@\([^)]*\)/, '');
  assert.notEqual(noRuntime, PACKAGING, '变异没生效：没找到 $vcRuntime 数组定义');
  assert.equal(hasVcRuntimeCopy(noRuntime), false, '删掉运行库数组后「拷贝」判定仍为通过');
  assert.equal(hasVcRuntimeGuard(noRuntime), false, '删掉运行库数组后「三档守卫」判定仍为通过');

  // 负向自证 2：整块拷贝逻辑删掉（只留原样 windeployqt + 守卫）→ 必须变红。
  const noCopy = dropBlock(PACKAGING, 'if ($crtSrc)');
  assert.notEqual(noCopy, PACKAGING, '变异没生效：没找到 $crtSrc 拷贝块');
  assert.equal(hasVcRuntimeCopy(noCopy), false, '删掉「从 CRT 目录拷贝」整块后判定仍为通过');

  // 负向自证 3：守卫倒退回「单个 DLL 缺失就 throw」→ 必须变红（这正是本轮要修掉的误红写法）。
  const eagerThrow = PACKAGING.replace(
    'if (-not (Test-Path (Join-Path $dist $name))) { $vcMissing += $name }',
    'if (-not (Test-Path (Join-Path $dist $name))) { throw "缺 VC++ 运行库 $name" }');
  assert.notEqual(eagerThrow, PACKAGING, '变异没生效：没找到运行库回验循环体');
  assert.equal(hasVcRuntimeGuard(eagerThrow), false, '退回「缺一个就 throw」后判定仍为通过');

  // 负向自证 4：把 vc_redist 兜底分支的条件去掉（elseif ($true) = 只要缺就用安装器顶过去，
  // 装器也不看）→ 必须变红：throw 分支必须真的要求「DLL 与 vc_redist 都没有」。
  const noRedistCheck = PACKAGING.replace('elseif (Test-Path $vcRedist) {', 'elseif ($true) {');
  assert.notEqual(noRedistCheck, PACKAGING, '变异没生效：没找到 vc_redist 兜底分支');
  assert.equal(hasVcRuntimeGuard(noRedistCheck), false,
    '去掉「包里真有 vc_redist.x64.exe」这个条件后判定仍为通过（throw 分支形同虚设）');

  // 负向自证 5：把开关加回去 → 本用例的 --no-compiler-runtime 断言必须能抓到。
  const regressed = PACKAGING.replace('windeployqt --release',
    'windeployqt --no-compiler-runtime --release');
  assert.notEqual(regressed, PACKAGING, '变异没生效：没找到 windeployqt --release');
  assert.equal(dropsCompilerRuntime(regressed), true, '把 --no-compiler-runtime 加回去后仍判定为「没删除」');
});

test('④ 核心 OCCT 白名单缺任一库必须 throw（不许静默跳过）', () => {
  const keep = arrayLiteral(PACKAGING, 'keep');
  for (const lib of REQUIRED_CORE) {
    assert.ok(new RegExp(`['"]${lib}['"]`).test(keep), `$keep 白名单里缺核心库 ${lib}`);
  }

  // 传递依赖同样必须逐字进 $keep：它们只出现在 TKV3d / TKDESTEP / TKDESTL 的 PE 导入表里，
  // 漏掉时 exe --version 与启动核对都发现不了，客户机一点视口/导 STEP 就 0xc0000135。
  const missingTransitive = missingKeepLibs(PACKAGING, REQUIRED_TRANSITIVE);
  assert.deepEqual(missingTransitive, [],
    `$keep 白名单里缺 OCCT 8.0.1 传递依赖：${missingTransitive.join(', ')}`
    + '（TKV3d 静态导入 TKMesh/TKHLR，TKDESTEP/TKDESTL 静态导入其余 6 个）');

  // 负向自证：从白名单里划掉 TKMesh → 上面那条判定必须变红（否则断言是空转的）。
  const noMesh = PACKAGING.replace(/,\s*'TKMesh'/, '');
  assert.notEqual(noMesh, PACKAGING, "变异没生效：$keep 里没找到 'TKMesh'");
  assert.deepEqual(missingKeepLibs(noMesh, REQUIRED_TRANSITIVE), ['TKMesh'],
    '删掉 TKMesh 后判定仍为通过（断言空转）');

  // 传递依赖也必须走同一条「缺任一就 throw」的复制循环，而不是另开一段静默 continue。
  for (const lib of REQUIRED_TRANSITIVE) {
    assert.ok(new RegExp(`['"]${lib}['"]`).test(keep), `传递依赖 ${lib} 不在 $keep 里，守卫覆盖不到它`);
  }

  const coreLoop = bodyOf(PACKAGING, /foreach\s*\(\s*\$lib\s+in\s+\$keep\s*\)\s*\{/, '$keep 复制循环');
  assert.match(coreLoop, /\$missing\s*\+=/, '缺库时必须记入 $missing，而不是静默 continue');
  assert.doesNotMatch(coreLoop, /if\s*\(\s*Test-Path\s+\$file\s*\)\s*\{\s*Copy-Item/,
    '仍在用 `if (Test-Path $file) { Copy-Item }` 的静默跳过写法');

  const guard = bodyOf(PACKAGING, /if\s*\(\s*\$missing\.Count\s+-gt\s+0\s*\)\s*\{/, '核心库缺库守卫');
  assert.match(guard, /throw/, '核心库缺失时必须 throw');
  assert.match(guard, /\$missing/, 'throw 的错误信息必须带上缺失路径（$missing）');
});

test('⑤ qt-client 显式链接的 TKSTL/TKDESTL 必须有候选复制 + 全落空 throw', () => {
  // 白名单和 CMake 的链接必须对得上：qt-client 用 find_library(NAMES TKSTL TKDESTL)
  // 显式链进 target，MSVC 是隐式链接 —— 包里缺这个 DLL 就是启动阶段 STATUS_DLL_NOT_FOUND。
  const cmake = readFileSync(new URL('../../qt-client/CMakeLists.txt', import.meta.url), 'utf8');
  assert.match(cmake, /find_library\(\s*OCCT_STL_LIB\s+NAMES\s+TKSTL\s+TKDESTL/,
    'qt-client 不再按 TKSTL/TKDESTL 找 STL 库：本用例的候选名单要跟着改');
  assert.match(cmake, /target_link_libraries\(automationcad-qt PRIVATE[\s\S]*\$\{OCCT_STL_LIB\}/,
    'qt-client 不再链接 ${OCCT_STL_LIB}：STL 库可能不再需要进包');

  const stl = arrayLiteral(PACKAGING, 'stlCandidates');
  assert.ok(/['"]TKSTL['"]/.test(stl), '$stlCandidates 里缺 TKSTL（OCCT 7.x 的 STL 读写库）');
  assert.ok(/['"]TKDESTL['"]/.test(stl), '$stlCandidates 里缺 TKDESTL（OCCT 8.0 拆分后的 STL 读写库）');
  assert.ok(hasStlGuard(PACKAGING),
    'STL 库没进包：需要 $stlCandidates + Copy-Item + Test-Path 回验 + 全落空 throw 三件套');

  // 负向自证 A：把候选数组那一行删掉（就是 /tmp 副本实验做的那一刀）→ 判定必须变红。
  const noArray = PACKAGING.replace(/\$stlCandidates\s*=\s*@\([^)]*\)\n/, '');
  assert.notEqual(noArray, PACKAGING, '变异没生效：没找到 $stlCandidates 数组定义');
  assert.equal(hasStlGuard(noArray), false, '删掉 STL 候选数组后判定仍为通过（断言是空转的）');

  // 负向自证 B：数组留着、只删「一个都没命中就 throw」→ 也必须变红（否则回到静默跳过）。
  const noThrow = PACKAGING.replace(/if \(\$stlCopied\.Count -eq 0\) \{\n\s*throw[^\n]*\n\s*\}\n/, '');
  assert.notEqual(noThrow, PACKAGING, '变异没生效：没找到 STL 缺库守卫');
  assert.equal(hasStlGuard(noThrow), false, '删掉 STL 缺库守卫后判定仍为通过');
});

test('⑥ 第三方依赖：硬依赖缺一个就 throw，且「一个都没复制到」也要 throw', () => {
  const req = arrayLiteral(PACKAGING, 'depsRequired');
  for (const dep of ['freetype.dll', 'libpng16.dll', 'zlib.dll']) {
    assert.ok(req.includes(`'${dep}'`), `$depsRequired 里缺 ${dep}（TKV3d / 基础几何库的硬依赖）`);
  }
  // tbb 只告警不 throw：conda-forge 的 occt 运行期确实依赖 tbb，但 DLL 名带 soname
  // （tbb12 → 将来 tbb13），把固定名写成硬依赖会在版本升级时误伤整个打包 job。
  assert.doesNotMatch(req, /tbb/, 'tbb 属软依赖（名字带 soname），不该写进 $depsRequired');
  assert.ok(hasHardDepGuard(PACKAGING),
    '第三方依赖缺库仍然只打印：$depsRequired 命中时必须 throw，且 $depsCopied 为 0 时也要 throw');

  // 负向自证：删掉硬依赖 guard → 变红。
  const noHard = PACKAGING.replace(/if \(\$depsRequiredMissing\.Count -gt 0\) \{\n\s*throw[^\n]*\n\s*\}\n/, '');
  assert.notEqual(noHard, PACKAGING, '变异没生效：没找到第三方硬依赖守卫');
  assert.equal(hasHardDepGuard(noHard), false, '删掉硬依赖守卫后判定仍为通过');

  // 负向自证：删掉「全缺」兜底 guard → 同样变红。
  const noZero = PACKAGING.replace(/if \(\$depsCopied -eq 0\) \{\n\s*throw[^\n]*\n\s*\}\n/, '');
  assert.notEqual(noZero, PACKAGING, '变异没生效：没找到依赖全缺兜底守卫');
  assert.equal(hasHardDepGuard(noZero), false, '删掉「全缺」兜底守卫后判定仍为通过');
});

test('⑦ braceBody 跳过引号/注释里的括号（字符串里出现 { 不会错切）', () => {
  const sample = [
    'if ($x) {',
    '  Write-Host "prefix {a}b"',
    "  $s = '}'",
    '  $t = "闭括号 } 在字符串里"',
    '  $u = "转义 `" { 也不算"',
    '  # 行注释里的 { 也不算',
    '  $v = @{ name = "值" }',
    '}',
    'AFTER_THE_BLOCK',
  ].join('\n');

  /** 改之前的实现：朴素计数，字符串里的 } 会被当成本块结束。 */
  function naiveBody(text, openIdx) {
    let depth = 0;
    for (let i = openIdx; i < text.length; i += 1) {
      if (text[i] === '{') depth += 1;
      else if (text[i] === '}') {
        depth -= 1;
        if (depth === 0) return text.slice(openIdx + 1, i);
      }
    }
    return null;
  }

  const openIdx = sample.indexOf('{');
  const body = braceBody(sample, openIdx);
  assert.match(body, /\$v = @\{ name = "值" \}/, '块体没覆盖到末尾的 @{...}：字符串里的 } 把块切短了');
  assert.match(body, /行注释里的 \{/, '块体没覆盖到注释行');
  assert.doesNotMatch(body, /AFTER_THE_BLOCK/, '块体越过了真正的收尾大括号');

  // 负向自证：同一样本用朴素计数必须切错，否则这条改动的价值无法证明。
  const naive = naiveBody(sample, openIdx);
  assert.notEqual(naive, body, '负向自证失败：朴素计数与跳引号实现结果相同，说明样本没覆盖到该场景');
  assert.doesNotMatch(naive, /\$v = @\{/, '负向自证失败：朴素计数没有在字符串的 } 处提前收尾');
});

/** 把 `head {...}` 整块从文本里删掉（负向自证用）。找不到 head 时原样返回。 */
function dropBlock(text, head) {
  const at = text.indexOf(head);
  if (at < 0) return text;
  const openIdx = text.indexOf('{', at + head.length - 1);
  if (openIdx < 0) return text;
  const bodyLen = braceBody(text, openIdx).length;
  return text.slice(0, at) + text.slice(openIdx + bodyLen + 2);   // +2：两侧大括号
}

/**
 * ⑧ tbb 一族：tbb*.dll 通配（排除 *_debug*）→ 命中逐个 Copy-Item + Test-Path 回验；
 * 一个都不命中时，只有「这个 occt build 声明依赖 tbb」才 throw（判据读 conda-meta，不靠版本号猜）。
 */
function hasTbbGuard(text) {
  try {
    // 退回固定名（tbb12.dll / tbbmalloc.dll）就是复审 §3.2 那类洞的原样回归。
    if (/tbb/i.test(arrayLiteral(text, 'deps'))) return false;
    if (!/\$tbbDlls\s*=\s*@\(/.test(text)) return false;
    if (!/Get-ChildItem\s+-Path\s+\$depDirs\s+-Filter\s+'tbb\*\.dll'/.test(text)) return false;
    if (!/-notlike\s+'\*_debug\*'/.test(text)) return false;
    const loop = bodyOf(text, /foreach\s*\(\s*\$tbb\s+in\s+\$tbbDlls\s*\)\s*\{/, 'tbb 复制循环');
    if (!/Copy-Item\s+\$tbb\.FullName\s+\$dist/.test(loop)) return false;
    if (!/Test-Path\s*\(\s*Join-Path\s+\$dist\s+\$tbb\.Name\s*\)/.test(loop)) return false;
    if (!/throw/.test(loop)) return false;
    const guard = bodyOf(text, /if\s*\(\s*\$tbbDlls\.Count\s+-eq\s+0\s*\)\s*\{/, 'tbb 缺库守卫');
    // 一刀切 throw 会误伤「本来就不带 tbb 的 build」，所以缺少时必须看 $tbbRequired 这个判据；
    // 判据必须来自包内 DLL 导入表的实测扫描：默认 $false，$true 只能出现在扫描之后。
    const scanAt = text.indexOf('ReadAllBytes');
    const trueAt = text.search(/\$tbbRequired\s*=\s*\$true/);
    if (!/\$tbbRequired\s*=\s*\$false/.test(text)) return false;
    if (scanAt < 0 || trueAt < 0 || trueAt < scanAt) return false;
    if (!/tbb\\d\+\\\.dll/.test(text)) return false;
    return /throw/.test(guard) && /\$tbbRequired/.test(guard);
  } catch {
    return false;
  }
}

test('⑧ tbb 一族按通配守卫：不写死 soname，命中逐个复制，该缺时 throw', () => {
  assert.ok(hasTbbGuard(PACKAGING),
    'tbb 仍然写死名字或没有缺库守卫：需要 tbb*.dll 通配 + *_debug 过滤 + 逐个 Copy-Item/Test-Path + 缺库 throw');
  // 「tbb 是否必需」要有依据：实测扫包里 DLL 的导入表，而不是写死 $true 或凭版本号猜。
  assert.match(PACKAGING, /\$tbbRequired\s*=\s*\$false/,
    'tbb 默认值必须是 $false：conda-forge 的 occt novtk build 不带 tbb，默认当必需会把本来绿的 job 变红');
  const scanAt = PACKAGING.indexOf('ReadAllBytes');
  assert.ok(scanAt > 0 && PACKAGING.search(/\$tbbRequired\s*=\s*\$true/) > scanAt,
    'tbb 必需的 $true 必须来自「扫包内 DLL 导入表」的结果，不能写死在扫描之前');
  assert.match(PACKAGING, /tbb\\d\+\\\.dll/,
    'tbb 是否必需没有实测依据：需要扫包内 DLL 的导入表找 tbb\\d*.dll');

  // 负向自证 1：把 tbb12.dll / tbbmalloc.dll 写回 $deps → 必须变红（这正是本轮要堵的回归）。
  const hardcoded = PACKAGING.replace("$deps = @('FreeImage.dll'",
    "$deps = @('tbb12.dll','tbbmalloc.dll','FreeImage.dll'");
  assert.notEqual(hardcoded, PACKAGING, '变异没生效：没找到 $deps 数组定义');
  assert.equal(hasTbbGuard(hardcoded), false, '把 tbb12.dll 写回 $deps 后判定仍为通过');

  // 负向自证 2：通配退化成固定名 → 必须变红。
  const fixedFilter = PACKAGING.replace("-Filter 'tbb*.dll'", "-Filter 'tbb12.dll'");
  assert.notEqual(fixedFilter, PACKAGING, '变异没生效：没找到 tbb 通配查找');
  assert.equal(hasTbbGuard(fixedFilter), false, 'tbb 通配退化成固定名后判定仍为通过');

  // 负向自证 3：只删「一个都没命中」的守卫 → 必须变红（否则回到「全缺只告警」）。
  const noGuard = dropBlock(PACKAGING, 'if ($tbbDlls.Count -eq 0)');
  assert.notEqual(noGuard, PACKAGING, '变异没生效：没找到 tbb 缺库守卫');
  assert.equal(hasTbbGuard(noGuard), false, '删掉 tbb 缺库守卫后判定仍为通过');

  // 负向自证 4：把默认值改成 $true（一刀切当必需，等于拿「novtk build 不带 tbb」赌运气）→ 变红。
  const alwaysOn = PACKAGING.replace('$tbbRequired = $false', '$tbbRequired = $true');
  assert.notEqual(alwaysOn, PACKAGING, '变异没生效：没找到 $tbbRequired 的默认值');
  assert.equal(hasTbbGuard(alwaysOn), false, '把 tbb 默认改成「必需」后判定仍为通过');
});

/** 按两空格缩进的 job 名切出该 job 的 YAML 文本。 */
function jobBlock(text, jobName) {
  const lines = text.split('\n');
  const head = new RegExp(`^  ${jobName}:\\s*$`);
  const start = lines.findIndex((l) => head.test(l));
  if (start < 0) return null;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^ {2}[A-Za-z0-9_-]+:\s*$/.test(lines[i])) return lines.slice(start, i).join('\n');
  }
  return lines.slice(start).join('\n');
}

/** qt-windows-occt 的 create-args 里那条 occt spec（没 pin 时就是裸 'occt'）。 */
function occtSpec(text) {
  const job = jobBlock(text, 'qt-windows-occt');
  if (!job) return null;
  const lines = job.split('\n');
  const idx = lines.findIndex((l) => /^\s*create-args:\s*>-\s*$/.test(l));
  if (idx < 0) return null;
  const baseIndent = lines[idx].length - lines[idx].trimStart().length;
  for (let i = idx + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim()) continue;
    if (line.length - line.trimStart().length <= baseIndent) break;
    const token = line.trim();
    if (/^occt\S*$/.test(token)) return token;
  }
  return null;
}

// 已验证的区间：conda-forge 上 8.0.0 / 8.0.1 都存在，win-64 的 8.0.* 解析到
// occt-8.0.1-novtk_h6bfc850_101（bin 里是 TKDESTEP/TKDESTL，被 $stepCandidates/$stlCandidates 覆盖）。
const OCCT_PIN_RE = /^occt=8\.0(?:\.\*|\.\d+)?$|^occt>=8\.0,<8\.1$/;

function isOcctPinned(text) {
  const spec = occtSpec(text);
  if (!spec || spec === 'occt') return false;
  return OCCT_PIN_RE.test(spec);
}

test('⑨ OCCT 版本 pin 住：裸 occt 等于把「上游发版」变成无预兆红', () => {
  const spec = occtSpec(CI);
  assert.ok(spec, 'qt-windows-occt 的 create-args 里找不到 occt spec（setup-micromamba 结构变了？）');
  assert.ok(isOcctPinned(CI),
    `create-args 里的 occt 没 pin 到已验证的 8.0 系列（当前 ${spec}）：上游改名/升版会让打包 job 无预兆红`);

  // 代码侧确实按 OCCT 8 写（TKDESTL 只存在于 8.x），所以 pin 必须是 8.x，不是随便哪个版本。
  const cmake = readFileSync(new URL('../../qt-client/CMakeLists.txt', import.meta.url), 'utf8');
  assert.match(cmake, /OCCT 8\.0 把 STL 读写从 TKSTL 拆到了 TKDESTL/,
    'qt-client 注释不再提 OCCT 8.0：⑨ 的版本区间要跟着复核');

  // 负向自证 1：退回裸 occt → 变红。
  const unpinned = CI.replace(spec, 'occt');
  assert.notEqual(unpinned, CI, '变异没生效：没找到 occt spec');
  assert.equal(isOcctPinned(unpinned), false, '把版本 pin 去掉后判定仍为通过（断言是空转的）');

  // 负向自证 2：pin 到别的系列 → 也必须变红，证明断言真的约束了版本区间。
  const wrongSeries = CI.replace(spec, 'occt=7.8.*');
  assert.notEqual(wrongSeries, CI, '变异没生效：没找到 occt spec');
  assert.equal(isOcctPinned(wrongSeries), false, 'pin 到 7.8 仍判定为通过（版本断言没约束住）');
});

test('⑩ 依赖闭包：FreeImage 的兄弟 DLL 与 msvcp140_1/_2 必须真进包，且启动核对不许被 conda PATH 兜住', () => {
  // 实测踩过：包里缺 msvcp140_1/_2 与 FreeImage 静态导入的 jpeg8/tiff/openjp2/libwebp/libwebpmux/raw/
  // OpenEXR/Iex/Imath，共 11 个；conda 的 Library/bin 把它们兜住了，所以「在 CI 里跑 --version」一直是假绿，
  // 一直到把 Qt 塞进安装包、脱离 conda 才暴露 0xc0000135（run 41363864932）。
  const detectsClosure = (text) => {
    // ① 有 dumpbin 导入表扫描 + 系统 DLL 白名单，缺的不能静默放过
    if (!/dumpbin[^\n]*\/dependents/i.test(text)) return false;
    if (!/\$systemDlls\s*=/.test(text)) return false;
    if (!/throw "依赖闭包缺/.test(text)) return false;
    // ② 缺的能从前面的候选目录补回来（FreeImage 的 jpeg8 之类与它同源）
    if (!/DEP_CLOSURE_COPIED/.test(text)) return false;
    if (!/DEP_CLOSURE_OK/.test(text)) return false;
    return true;
  };
  assert.ok(detectsClosure(PACKAGING), `${CI_PATH_DISPLAY} 打包段缺少依赖闭包体检（dumpbin 扫导入表 → 补拷 → 仍缺就 throw）`);

  // 负向自证：把 throw 去掉，判定必须变红，证明断言不是摆设。
  const droppedThrow = PACKAGING.replace(/throw "依赖闭包缺/, 'Write-Host "依赖闭包缺');
  assert.notEqual(droppedThrow, PACKAGING, '变异没生效：没找到「依赖闭包缺」的 throw');
  assert.equal(detectsClosure(droppedThrow), false, '把闭包 throw 去掉后判定仍通过（断言空转）');

  // ③ VC 运行时必须带上 msvcp140_1 / msvcp140_2 / concrt140：exe 与 Qt6Gui 静态导入 msvcp140_2
  const vcLine = (PACKAGING.match(/\$vcRuntime\s*=\s*@\(([^)]*)\)/) || [])[1] || '';
  for (const name of ['msvcp140_1.dll', 'msvcp140_2.dll', 'concrt140.dll']) {
    assert.ok(vcLine.includes(name), `$vcRuntime 少了 ${name}：纯净机加载 automationcad-qt.exe / Qt6Gui 时 0xc0000135`);
  }
  // vcomp140（OpenMP）在 Microsoft.VC*.OpenMP 目录，不在 .CRT 里，必须单独补拷
  assert.match(PACKAGING, /VC_OPENMP_COPIED vcomp140\.dll/, 'OpenMP 运行库 vcomp140.dll 没有单独的补拷逻辑（FreeImage/OpenEXR 常带 /openmp）');

  // ④ 启动核对必须先把 conda 相关目录从 PATH 摘掉，否则缺的 DLL 会被 Library/bin 兜住 → 假绿
  const launch = stepBlock(LINES, '从打包目录启动并核对版本');
  assert.ok(launch, `${CI_PATH_DISPLAY} 找不到「从打包目录启动并核对版本」step`);
  assert.ok(launch.includes("notmatch '(?i)micromamba|conda'"),
    '启动核对没有把 conda 目录从 PATH 摘掉：包里缺 DLL 也会显示通过（假绿）');
});

test('发布流程不变量：打包仍是 OCCT job 的产物，上传路径与产物名不变', () => {
  assert.match(CI, /name:\s*automationcad-qt-windows-x64-occt\s*\n\s*path:\s*dist\/automationcad-qt-windows-x64-occt\.zip/,
    '上传 artifact 的名称/路径被改动了');
  assert.match(PACKAGING, /PACKAGE_OCCT_OK/, '打包成功标记 PACKAGE_OCCT_OK 不能丢');
});
