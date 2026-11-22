// 共享 three 表面的回归测试：既要覆盖 layout-editor 分块的真实运行时需求，
// 又不能退化成“把整包 three 塞进核心”。
//
// 判定依据来自源码，而不是手写白名单：
// - 核心包：src/**/*.ts（排除 extension.ts、本模块、layout-editor 与 modules/chunks）
//   里所有 `import * as THREE` 的静态属性访问，以及 `from 'three'` 的具名导入；
// - 分块：src/layout-editor/** 的同口径访问，加上它直接/间接导入的
//   three/addons 源码里 `from 'three'` 的具名导入（OrbitControls / TransformControls
//   需要 Controls、Ray、Spherical 等核心原本没用的符号）。
// 类型位置（`THREE.Mesh` 之类的 TypeReference）不计入运行时需求。
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import ts from 'typescript';
import * as THREE from 'three';
import { SHARED_THREE } from '../../src/modules/shared-deps.ts';

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(here, '../..');
const requireFromDesktop = createRequire(join(desktopRoot, 'package.json'));

/** 明显与布局编辑/核心视口无关的重型导出；出现任意一个都说明退化成了整包兜底。 */
const HEAVY_UNUSED = [
  'PMREMGenerator',
  'WebGPURenderer',
  'GLTFLoader',
  'DRACOLoader',
  'KTX2Loader',
  'ObjectLoader',
  'Audio',
  'AudioAnalyser',
  'AnimationMixer',
  'AnimationClip',
  'Skeleton',
  'SkinnedMesh',
  'BatchedMesh',
  'WebXRController',
  'CompressedTextureLoader',
  'CubeTextureLoader',
  'TextureLoader',
  'FileLoader',
  'ImageBitmapLoader',
  'InstancedBufferGeometry',
  'ShaderMaterial',
  'RawShaderMaterial',
  'WebGLRenderTarget',
  'WebGLCubeRenderTarget',
  'Points',
  'Sprite',
  'Fog'
];

async function listTypeScriptFiles(dir) {
  const files = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await listTypeScriptFiles(path));
    else if (entry.name.endsWith('.ts')) files.push(path);
  }
  return files;
}

/** `THREE.Vector3` 出现在类型标注里（TypeReference/QualifiedName）不需要运行时值。 */
function isTypePosition(node) {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (ts.isTypeNode(parent) && !ts.isTypeQueryNode(parent)) return true;
    if (ts.isExpression(parent)) break;
  }
  return false;
}

/**
 * 收集一个源文件对 three 的运行时依赖。
 * @param {ts.SourceFile} sourceFile
 * @param {Set<string>} out
 */
function collectThreeUsage(sourceFile, out) {
  const namespaceAliases = new Set();
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || statement.moduleSpecifier.text !== 'three') continue;
    const clause = statement.importClause;
    if (!clause || clause.isTypeOnly) continue;
    const bindings = clause.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) namespaceAliases.add(bindings.name.text);
    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        if (!element.isTypeOnly) out.add(element.name.text);
      }
    }
  }
  if (namespaceAliases.size === 0) return;
  (function visit(node) {
    if (ts.isPropertyAccessExpression(node)
      && ts.isIdentifier(node.expression)
      && namespaceAliases.has(node.expression.text)
      && !isTypePosition(node)) {
      out.add(node.name.text);
    }
    ts.forEachChild(node, visit);
  })(sourceFile);
}

function parseSource(file, text, kind = ts.ScriptKind.TS) {
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
}

/** 核心包里的 three 运行时符号；排除注入点、共享表、迁移出去的分块源码。 */
async function coreThreeSymbols() {
  const excluded = [
    join(desktopRoot, 'src', 'extension.ts'),
    join(desktopRoot, 'src', 'modules', 'shared-deps.ts'),
    join(desktopRoot, 'src', 'layout-editor'),
    join(desktopRoot, 'src', 'modules', 'chunks')
  ];
  const symbols = new Set();
  for (const file of await listTypeScriptFiles(join(desktopRoot, 'src'))) {
    if (excluded.some((prefix) => file === prefix || file.startsWith(`${prefix}/`))) continue;
    collectThreeUsage(parseSource(file, await readFile(file, 'utf8')), symbols);
  }
  return symbols;
}

/** layout-editor 分块源码 + 它用到的 three/addons 对 three 的运行时符号。 */
async function layoutChunkThreeSymbols() {
  const symbols = new Set();
  const addonSpecifiers = new Set();
  const sourceFiles = [
    ...await listTypeScriptFiles(join(desktopRoot, 'src', 'layout-editor')),
    join(desktopRoot, 'src', 'modules', 'chunks', 'design-layout-editor.ts')
  ];
  for (const file of sourceFiles) {
    const sourceFile = parseSource(file, await readFile(file, 'utf8'));
    collectThreeUsage(sourceFile, symbols);
    for (const statement of sourceFile.statements) {
      if (ts.isImportDeclaration(statement) && statement.moduleSpecifier.text.startsWith('three/addons/')) {
        addonSpecifiers.add(statement.moduleSpecifier.text);
      }
    }
  }

  // addons 是随分块一起打包的 JS；它们内部的 `from 'three'` 同样走共享表，
  // 所以必须把具名导入计入需求。递归只是为了以后 addon 再引用别的 addon 时不漏。
  const seen = new Set();
  const queue = [...addonSpecifiers];
  while (queue.length > 0) {
    const specifier = queue.shift();
    let file;
    try {
      file = requireFromDesktop.resolve(specifier);
    } catch {
      continue;
    }
    if (seen.has(file)) continue;
    seen.add(file);
    const sourceFile = parseSource(file, await readFile(file, 'utf8'), ts.ScriptKind.JS);
    collectThreeUsage(sourceFile, symbols);
    for (const statement of sourceFile.statements) {
      if (!ts.isImportDeclaration(statement)) continue;
      const next = statement.moduleSpecifier.text;
      if (next === 'three' || next.startsWith('three/addons/') || next.startsWith('.')) {
        try {
          queue.push(createRequire(file).resolve(next));
        } catch {
          // addon 内部的可选依赖解析不到时不影响 three 符号判定。
        }
      }
    }
  }
  return symbols;
}

test('共享表恰好覆盖核心 ∪ layout-editor 分块的 three 运行时符号', async () => {
  const core = await coreThreeSymbols();
  const chunk = await layoutChunkThreeSymbols();
  const required = new Set([...core, ...chunk]);
  const shared = new Set(Object.keys(SHARED_THREE));

  assert.ok(chunk.size > 20, `layout-editor 分块应解析出真实 three 需求，实际 ${chunk.size}`);
  // 这两类符号是 OrbitControls / TransformControls 的硬依赖，抽查防止解析器空转。
  for (const name of ['WebGLRenderer', 'Mesh', 'Raycaster', 'Controls', 'Spherical', 'TOUCH']) {
    assert.ok(chunk.has(name), `layout-editor 分块应需要 three.${name}`);
  }

  const missing = [...required].filter((name) => !shared.has(name)).sort();
  const extra = [...shared].filter((name) => !required.has(name)).sort();
  assert.deepEqual(missing, [], `共享表缺少运行时符号：${missing.join(', ')}`);
  assert.deepEqual(extra, [], `共享表包含未使用的符号（会拖大核心包）：${extra.join(', ')}`);
  assert.equal(shared.size, required.size);
  assert.ok(shared.size < 64, `共享表应保持白名单规模，实际 ${shared.size} 个符号`);
});

test('共享表的值就是 three 的同一实例，不是复制或包装', () => {
  for (const [name, value] of Object.entries(SHARED_THREE)) {
    assert.equal(Object.hasOwn(THREE, name), true, `three 没有导出 ${name}`);
    assert.equal(value, THREE[name], `共享表 THREE.${name} 必须与 three 导出同一引用`);
    assert.notEqual(value, undefined, `共享表 THREE.${name} 不能是 undefined`);
  }
  assert.equal(Object.hasOwn(SHARED_THREE, 'default'), false, '共享表不应包含 default');
});

test('共享表没有重型未使用导出，防止退回整包', () => {
  const present = HEAVY_UNUSED.filter((name) => Object.hasOwn(SHARED_THREE, name));
  assert.deepEqual(present, [], `共享表不应包含重型未使用导出：${present.join(', ')}`);
  assert.ok(Object.keys(SHARED_THREE).length <= 60, '符号数超过 60 时请先确认不是整包兜底');
});

test('shared-deps 只使用具名导入，extension 不再直接依赖 three 命名空间', async () => {
  const sharedDepsPath = join(desktopRoot, 'src', 'modules', 'shared-deps.ts');
  const sharedDeps = parseSource(sharedDepsPath, await readFile(sharedDepsPath, 'utf8'));
  let imported = 0;
  for (const statement of sharedDeps.statements) {
    if (ts.isImportDeclaration(statement) && statement.moduleSpecifier.text === 'three') {
      assert.equal(statement.importClause?.name, undefined, '不得默认导入 three');
      const bindings = statement.importClause?.namedBindings;
      assert.ok(bindings && ts.isNamedImports(bindings), 'three 必须使用具名导入');
      imported = bindings.elements.length;
    }
    if (ts.isExportDeclaration(statement) && statement.moduleSpecifier?.text === 'three') {
      assert.fail('禁止从 three 整体再导出（export * / export ... from）');
    }
  }
  assert.equal(imported, Object.keys(SHARED_THREE).length, '具名导入数量必须与共享表属性数量一致');

  const extensionPath = join(desktopRoot, 'src', 'extension.ts');
  const extensionSource = await readFile(extensionPath, 'utf8');
  const extension = parseSource(extensionPath, extensionSource);
  for (const statement of extension.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    assert.notEqual(statement.moduleSpecifier.text, 'three', 'extension.ts 不得直接导入 three');
    if (statement.moduleSpecifier.text !== './modules/shared-deps.ts') continue;
    const bindings = statement.importClause?.namedBindings;
    const names = bindings && ts.isNamedImports(bindings)
      ? bindings.elements.map((element) => element.name.text)
      : [];
    assert.deepEqual(names, ['SHARED_THREE'], 'extension.ts 必须从 shared-deps 取 SHARED_THREE');
  }
  assert.match(extensionSource, /registry\.THREE\s*=\s*SHARED_THREE/, 'extension.ts 必须注入共享表');
});
