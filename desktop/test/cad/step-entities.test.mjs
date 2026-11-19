/**
 * `src/cad/step-entities.ts` 的专用测试：原始装配树回读 + 逐实体身份判定的**负向自证**。
 *
 * 这套测试的价值全在「旧证据看不见、新证据看得见」：
 *   - 旧路（`parseOcctBuffer` + `readablePartNames`）会把路径叶剥掉、把重名件改写成 `-2`，
 *     所以「丢件号」「重号件表」在那条路上是**假绿**；这里每条变异都钉住新模块必须红；
 *   - 逐件实体数用「回读网格数」对照件表 solids —— 但只在**受限格式**（compound 无布尔导出）
 *     成立，测试里明确写出这个前提，不把它说成无条件的 BRep 实体数。
 *
 * 合成 raw 树（`fakeOcct`）覆盖结构类失败：无归属网格 / 网格被多节点引用 / 坏 indices /
 * NaN / 深度截断 / 伪造空树。真 fixtures（P1 生成）覆盖「真 bytes 回读」这一层：
 * `step-identity-3parts.step`（含完全被包住件）与 `step-identity-multisolid.step`
 * （一个多实体件 + 一个单实体件）。
 *
 * 边界（不许在这份测试里越界声称）：这里证明的是导出侧逐件身份（件名 + 包络 + 实体数），
 * **不证明** identity.step 与制造 STEP 内部拓扑/形状等价，也不认证材质/可制造性。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import occtimportjs from 'occt-import-js';

import {
  ENTITY_DEPTH_LIMIT,
  decodeStepString,
  matchEntityIdentity,
  readStepEntities,
  readStepManifoldSolidCount,
  readStepMeshEnvelope,
  readStepProductNames
} from '../../src/cad/step-entities.ts';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = resolve(here, '../fixtures');
const FIXTURE_3PARTS = resolve(FIXTURE_DIR, 'step-identity-3parts.step');
const FIXTURE_MULTISOLID = resolve(FIXTURE_DIR, 'step-identity-multisolid.step');

let occtPromise = null;
function loadOcct() {
  if (!occtPromise) occtPromise = occtimportjs();
  return occtPromise;
}

/** 12 个三角面的箱体网格（满足「非退化 ≥12 面」下界）。 */
function boxMesh(min, max, name = '') {
  const [x0, y0, z0] = min;
  const [x1, y1, z1] = max;
  const positions = [
    x0, y0, z0, x1, y0, z0, x1, y1, z0, x0, y1, z0,
    x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1
  ];
  const faces = [
    [0, 1, 2, 3], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]
  ];
  const index = [];
  for (const [a, b, c, d] of faces) index.push(a, b, c, a, c, d);
  return { name, attributes: { position: { array: positions } }, index: { array: index } };
}

function treeNode(name, meshes = [], children = []) {
  return { name, meshes, children };
}

/** 伪造的 occt 模块：直接给 raw root/meshes，用来把「结构类失败」逐条钉住。 */
function fakeOcct(meshes, root) {
  const result = { success: true, meshes, root };
  return {
    ReadStepFile: () => result,
    ReadIgesFile: () => result,
    ReadBrepFile: () => result
  };
}

function readFake(meshes, root) {
  return readStepEntities(new Uint8Array([0]), fakeOcct(meshes, root));
}

/** 从回读结果造一份自洽的判定事实（绿基线），变异再逐条打。 */
function factsFromReadback(readback, overrides = {}) {
  const parts = readback.entities.map((entity) => ({
    id: entity.leaf,
    bboxMin: [...entity.bbox.min],
    bboxMax: [...entity.bbox.max],
    solids: entity.meshCount
  }));
  return {
    partTableIds: parts.map((part) => part.id),
    parts,
    readback,
    identitySolids: readback.meshCount,
    partSolids: parts.reduce((sum, part) => sum + part.solids, 0),
    mergedBBox: readback.bbox,
    mergedProductNames: ['assembly'],
    identityPath: '/tmp/r12-build/identity.step',
    stepPath: '/tmp/r12-build/step.step',
    identityBytes: 4096,
    ...overrides
  };
}

function boxInside(inner, outer, tolerance = 1e-6) {
  let strict = false;
  for (let axis = 0; axis < 3; axis += 1) {
    if (inner.min[axis] < outer.min[axis] - tolerance) return false;
    if (inner.max[axis] > outer.max[axis] + tolerance) return false;
    if ((inner.max[axis] - inner.min[axis]) < (outer.max[axis] - outer.min[axis]) - tolerance) strict = true;
  }
  return strict;
}

/** 三件箱体 + 根节点 assembly：a 大、b 完全在 a 里、c 在别处（薄板）。 */
function threePartTree() {
  const meshes = [
    boxMesh([0, 0, 0], [100, 100, 400], 'post'),
    boxMesh([30, 30, 180], [50, 50, 200]), // 完全被包住（探针 A 的 lift-chain 位形）
    boxMesh([150, 0, 410], [450, 60, 413], 'tray')
  ];
  const root = treeNode('assembly', [], [
    treeNode('post-01', [0]),
    treeNode('chain-01', [1]),
    treeNode('tray-01', [2])
  ]);
  return { meshes, root };
}

/* ---------------------------------------------------------------------------
 * 一、装配树回读：结构类失败一律判红（有限验证失败即红，不静默丢）
 * ------------------------------------------------------------------------- */

test('回读：同名兄弟节点各成一个实例（不许先按件号合并，否则重号永远查不出来）', () => {
  const meshes = [boxMesh([0, 0, 0], [10, 10, 10]), boxMesh([20, 0, 0], [30, 10, 10])];
  const root = treeNode('assembly', [], [treeNode('tray-1', [0]), treeNode('tray-1', [1])]);
  const read = readFake(meshes, root);

  assert.equal(read.ok, true, read.errors.join('；'));
  assert.equal(read.entities.length, 2, '两个节点 = 两个实体实例');
  assert.deepEqual(read.entities.map((entity) => entity.leaf), ['tray-1', 'tray-1']);
  assert.deepEqual(read.entities.map((entity) => entity.meshCount), [1, 1], '每个实例只带自己的网格');

  // 同名节点被合并（或按件号去重）时，这里的 dup 会消失 —— 那正是要防的假绿
  const result = matchEntityIdentity(factsFromReadback(read, {
    partTableIds: ['tray-1'],
    parts: [{ id: 'tray-1', bboxMin: [0, 0, 0], bboxMax: [10, 10, 10], solids: 1 }],
    partSolids: 1,
    identitySolids: 2
  }));
  assert.equal(result.ok, false);
  assert.ok(result.entityIdentity.duplicateIds.includes('tray-1'), JSON.stringify(result.entityIdentity));
  assert.match(result.checks[1].actual, /重号/);
});

test('回读：一个网格被两个装配节点引用 → 判红（一条网格挂两个件号 = 实体数放大）', () => {
  const meshes = [boxMesh([0, 0, 0], [10, 10, 10])];
  const root = treeNode('assembly', [], [treeNode('a', [0]), treeNode('b', [0])]);
  const read = readFake(meshes, root);
  assert.equal(read.ok, false);
  assert.match(read.errors.join('\n'), /被多个装配节点引用/);
});

test('回读：网格没有装配归属 → 判红（无名网格不许当成件，也不许静默丢弃）', () => {
  const meshes = [boxMesh([0, 0, 0], [10, 10, 10]), boxMesh([20, 0, 0], [30, 10, 10])];
  const root = treeNode('assembly', [], [treeNode('a', [0])]);
  const read = readFake(meshes, root);
  assert.equal(read.ok, false);
  assert.match(read.errors.join('\n'), /没有装配归属/);

  const result = matchEntityIdentity(factsFromReadback(read, { identitySolids: 2 }));
  assert.equal(result.ok, false, '回读不可信时四条判据一条都不许绿');
  assert.ok(result.checks.every((check) => check.ok === false), JSON.stringify(result.checks.map((c) => c.ok)));
});

test('回读：坏 indices（越界 / 非整数）→ 判红，不许把面静默丢掉', () => {
  const outOfRange = boxMesh([0, 0, 0], [10, 10, 10]);
  outOfRange.index = { array: [0, 1, 99] };
  const read = readFake([outOfRange], treeNode('assembly', [], [treeNode('a', [0])]));
  assert.equal(read.ok, false);
  assert.match(read.errors.join('\n'), /坏 indices/);

  const fraction = boxMesh([0, 0, 0], [10, 10, 10]);
  fraction.index = { array: [0, 1, 1.5] };
  const read2 = readFake([fraction], treeNode('assembly', [], [treeNode('a', [0])]));
  assert.equal(read2.ok, false, '非整数索引也是坏 indices');
});

test('回读：顶点含 NaN/Infinity → 判红（NaN 会毒化全部包络比较）', () => {
  const broken = boxMesh([0, 0, 0], [10, 10, 10]);
  broken.attributes.position.array[3] = Number.NaN;
  const read = readFake([broken], treeNode('assembly', [], [treeNode('a', [0])]));
  assert.equal(read.ok, false);
  assert.match(read.errors.join('\n'), /NaN|Infinity/);

  const infinite = boxMesh([0, 0, 0], [10, 10, 10]);
  infinite.attributes.position.array[1] = Number.POSITIVE_INFINITY;
  const read2 = readFake([infinite], treeNode('assembly', [], [treeNode('a', [0])]));
  assert.equal(read2.ok, false, 'Infinity 同样不许进包络');
});

test('回读：装配树被深度截断 → 判红（不许截断后当成完整树判绿）', () => {
  let node = treeNode('leaf', [0]);
  for (let depth = 0; depth < ENTITY_DEPTH_LIMIT + 5; depth += 1) node = treeNode(`n${depth}`, [], [node]);
  const read = readFake([boxMesh([0, 0, 0], [10, 10, 10])], node);
  assert.equal(read.ok, false);
  assert.match(read.errors.join('\n'), /深度超过/);
});

test('回读：伪造 raw 树（成功但空 / 无 root / 抛错）→ 一律判红，空集合不许 .every 空转成绿', () => {
  const empty = readFake([], treeNode('assembly'));
  assert.equal(empty.ok, false);
  assert.match(empty.errors.join('\n'), /0 个网格/);

  const noRoot = readFake([boxMesh([0, 0, 0], [10, 10, 10])], undefined);
  assert.equal(noRoot.ok, false);
  assert.match(noRoot.errors.join('\n'), /装配根节点/);

  const throwing = readStepEntities(new Uint8Array([0]), {
    ReadStepFile: () => {
      throw new Error('坏文件');
    },
    ReadIgesFile: () => ({ success: false }),
    ReadBrepFile: () => ({ success: false })
  });
  assert.equal(throwing.ok, false);
  assert.match(throwing.errors.join('\n'), /读入抛错/);

  const failed = readStepEntities(new Uint8Array([0]), {
    ReadStepFile: () => ({ success: false, meshes: [], root: treeNode('x') }),
    ReadIgesFile: () => ({ success: false }),
    ReadBrepFile: () => ({ success: false })
  });
  assert.equal(failed.ok, false);
  assert.match(failed.errors.join('\n'), /success=false/);

  const emptyMatch = matchEntityIdentity({
    partTableIds: [],
    parts: [],
    readback: empty,
    identitySolids: 0,
    partSolids: 0,
    mergedBBox: null,
    mergedProductNames: [],
    identityPath: null,
    stepPath: null,
    identityBytes: 0
  });
  assert.equal(emptyMatch.ok, false);
  assert.ok(emptyMatch.checks.every((check) => check.ok === false), '空集合 + 缺产物必须四条全红');
});

/* ---------------------------------------------------------------------------
 * 二、逐实体身份判定：7 类行为变异各自红在自己的判据上
 * ------------------------------------------------------------------------- */

/** 绿基线：三件树 + 自洽事实，先断言绿，再逐条变异。 */
function greenBaseline() {
  const { meshes, root } = threePartTree();
  const read = readFake(meshes, root);
  assert.equal(read.ok, true, read.errors.join('；'));
  const facts = factsFromReadback(read);
  const green = matchEntityIdentity(facts);
  assert.equal(green.ok, true, JSON.stringify(green.checks));
  assert.equal(green.checks.length, 4);
  return { read, facts, green };
}

test('绿基线：三件（含完全被包住件）件名/包络/实体数三方一致 → 4 条全绿且给出真实差值', () => {
  const { green } = greenBaseline();
  assert.equal(green.entityIdentity.expectedParts, 3);
  assert.equal(green.entityIdentity.actualParts, 3);
  assert.equal(green.entityIdentity.expectedSolids, 3);
  assert.equal(green.entityIdentity.actualSolids, 3);
  assert.deepEqual(green.entityIdentity.unionDeltaMm, [0, 0, 0]);
  assert.equal(green.entityIdentity.bboxMaxDeltaMm, 0, '完全吻合要报 0.00 而不是 null（null 只表示没算）');
  assert.equal(green.entityIdentity.sameDir, true);
  // 残余限制必须随回执走，不许只活在注释里
  assert.ok(green.entityIdentity.boundaries.some((line) => /不证明 identity\.step 与融合制造 STEP/.test(line)));
  assert.ok(green.entityIdentity.boundaries.some((line) => /受限格式/.test(line)));
});

test('变异①：缺身份产物（旧内核没有 files.identity）→ 判红，明说未验证，不是 not-applicable', () => {
  const { facts } = greenBaseline();
  const result = matchEntityIdentity({
    ...facts,
    identityPath: null,
    identityBytes: 0,
    readback: { ...facts.readback, ok: false, errors: ['内核回执没有 files.identity'] }
  });
  assert.equal(result.ok, false);
  assert.equal(result.checks[0].ok, false);
  assert.match(result.checks[0].actual, /缺 files\.identity/);
  assert.equal(result.entityIdentity.applicable, true, 'build 语义下是「判了但没通过」，不是不适用');
  assert.notEqual(result.entityIdentity.ok, null, '缺产物不许退化成 null（那会被读成「跳过」）');
});

test('变异②：缺件 / 多出未知件 / 件表与 files.parts[] 不一致 → 件号集合那一条红并点名', () => {
  const { read, facts } = greenBaseline();

  const missing = matchEntityIdentity({
    ...facts,
    readback: { ...read, entities: read.entities.slice(0, 2) }
  });
  assert.equal(missing.ok, false);
  assert.ok(missing.entityIdentity.missingIds.includes('tray-01'), JSON.stringify(missing.entityIdentity.missingIds));

  const unknown = matchEntityIdentity({
    ...facts,
    readback: {
      ...read,
      entities: [...read.entities, { ...read.entities[0], leaf: 'ghost-99', rawName: 'ghost-99', path: ['assembly', 'ghost-99'] }]
    },
    identitySolids: 4,
    partSolids: 4
  });
  assert.equal(unknown.ok, false);
  assert.ok(unknown.entityIdentity.unknownIds.includes('ghost-99'));

  // 件表 ↔ files.parts[] 两个方向都要点名：少一条（内核漏报）与多一条（件表没有）是两种病
  const tableMissing = matchEntityIdentity({ ...facts, partTableIds: ['post-01', 'chain-01', 'tray-01', 'ghost-77'] });
  assert.equal(tableMissing.ok, false);
  assert.match(tableMissing.checks[1].actual, /件表有、files\.parts\[\] 无：ghost-77/);

  const tableUnknown = matchEntityIdentity({ ...facts, partTableIds: ['post-01', 'tray-01'] });
  assert.equal(tableUnknown.ok, false);
  assert.match(tableUnknown.checks[1].actual, /files\.parts\[\] 有、件表无：chain-01/);
});

test('变异③：实体从一件搬到另一件（总数不变）→ 逐件判据必须红，不是只看合计', () => {
  // 前提构型：一个两实体件 + 一个单实体件（与 step-identity-multisolid 同形），
  // 这样「2↔1 互换」才能让合计与总实体数**一个都不变**。
  const meshes = [
    boxMesh([0, 0, 0], [100, 100, 100], 'tube'),
    boxMesh([0, 0, 100], [100, 100, 200]),
    boxMesh([300, 0, 0], [400, 100, 100], 'plate')
  ];
  const root = treeNode('assembly', [], [treeNode('two-solid', [0, 1]), treeNode('plate', [2])]);
  const read = readFake(meshes, root);
  assert.equal(read.ok, true, read.errors.join('；'));
  assert.deepEqual(read.entities.map((entity) => entity.meshCount), [2, 1]);
  const facts = factsFromReadback(read);
  assert.equal(matchEntityIdentity(facts).ok, true);

  const swapped = facts.parts.map((part) => ({ ...part, solids: part.id === 'two-solid' ? 1 : 2 }));
  const total = swapped.reduce((sum, part) => sum + part.solids, 0);
  assert.equal(total, facts.partSolids, '前提：逐件合计不变');
  const result = matchEntityIdentity({ ...facts, parts: swapped, partSolids: total, identitySolids: total });
  assert.equal(result.ok, false);
  assert.deepEqual(
    result.entityIdentity.perPartSolidsMismatch.map((item) => [item.id, item.expected, item.actual]).sort(),
    [['plate', 2, 1], ['two-solid', 1, 2]]
  );
  assert.match(result.checks[2].actual, /逐件实体数不等/);
  // 其它三条仍然各自成立 —— 证明这条判据是**独立**的，不是被别的一起带红
  assert.deepEqual(result.checks.map((check) => check.ok), [true, true, false, true]);
});

test('变异④：换名不换形 / 换形不换名 → 件号与包络两条判据分别红', () => {
  const { read, facts } = greenBaseline();

  // 换名：把 tray-01 的叶改成 post-01 的镜像名（件号集合两边一起改，姓名级仍「自洽」）
  const renamed = matchEntityIdentity({
    ...facts,
    readback: {
      ...read,
      entities: read.entities.map((entity) => (
        entity.leaf === 'tray-01' ? { ...entity, leaf: 'tray-02', path: ['assembly', 'tray-02'] } : entity
      ))
    },
    parts: facts.parts.map((part) => (part.id === 'tray-01' ? { ...part, id: 'tray-02' } : part)),
    partTableIds: facts.partTableIds.map((id) => (id === 'tray-01' ? 'tray-02' : id))
  });
  assert.equal(renamed.ok, true, '对照：件名与件表同步改时「名字级」自洽 —— 所以必须另有几何绑定');

  // 换形：名字不动，把 tray-01 的包络换成 post-01 的盒
  const postBBox = facts.parts.find((part) => part.id === 'post-01');
  const swappedBox = matchEntityIdentity({
    ...facts,
    parts: facts.parts.map((part) => (
      part.id === 'tray-01' ? { ...part, bboxMin: [...postBBox.bboxMin], bboxMax: [...postBBox.bboxMax] } : part
    ))
  });
  assert.equal(swappedBox.ok, false);
  assert.ok(swappedBox.entityIdentity.bboxMismatches.length > 0);
  assert.ok(swappedBox.entityIdentity.bboxMaxDeltaMm > 1, '差值必须是真实算出来的毫米数');
  assert.match(swappedBox.checks[2].actual, /包络超差/);
});

test('变异⑤：identity.path 指到构建目录之外 / 指向制造 STEP 自身 → 产物判据红', () => {
  const { facts } = greenBaseline();

  const outside = matchEntityIdentity({ ...facts, identityPath: '/tmp/elsewhere/identity.step' });
  assert.equal(outside.ok, false);
  assert.equal(outside.entityIdentity.sameDir, false);
  assert.match(outside.checks[0].actual, /不同目录/);

  const alias = matchEntityIdentity({ ...facts, identityPath: facts.stepPath });
  assert.equal(alias.ok, false);
  assert.match(alias.checks[0].actual, /制造 STEP 自身/);

  const zeroBytes = matchEntityIdentity({ ...facts, identityBytes: 0 });
  assert.equal(zeroBytes.ok, false);
  assert.match(zeroBytes.checks[0].actual, /字节数非法/);
});

test('变异⑥：往制造 STEP 上贴件号（fuse 继承 parts[0].label）→ 污染判据红并点名件号', () => {
  const { facts } = greenBaseline();
  const dirty = matchEntityIdentity({ ...facts, mergedProductNames: ['assembly', 'post-01'] });
  assert.equal(dirty.ok, false);
  assert.deepEqual(dirty.entityIdentity.pollutionIds, ['post-01']);
  assert.match(dirty.checks[3].actual, /出现件号/);

  // 转义写法的件号同样要被抓到（\X2\ 是 OCCT 对非 ASCII 的写法；不解码就等于放过）
  const escaped = matchEntityIdentity({
    ...facts,
    mergedProductNames: [...readStepProductNames("#1=PRODUCT('\\X2\\0074007200610079002D00300031\\X0\\','',',(#2));")]
  });
  assert.ok(escaped.entityIdentity.pollutionIds.includes('tray-01'), '解码后必须命中件号');
  assert.equal(escaped.ok, false);
});

test('变异⑦：非法数值（solids=0 / 小数 / NaN；包络 NaN）→ 判红，且不许按 1 计', () => {
  const { facts } = greenBaseline();
  for (const solids of [0, 1.5, Number.NaN]) {
    const result = matchEntityIdentity({
      ...facts,
      parts: facts.parts.map((part) => (part.id === 'post-01' ? { ...part, solids } : part))
    });
    assert.equal(result.ok, false, `solids=${String(solids)} 必须红`);
    assert.ok(result.entityIdentity.invalidIds.length > 0, JSON.stringify(result.entityIdentity));
  }

  const nanBox = matchEntityIdentity({
    ...facts,
    parts: facts.parts.map((part) => (part.id === 'post-01' ? { ...part, bboxMin: [Number.NaN, 0, 0] } : part))
  });
  assert.equal(nanBox.ok, false);
  assert.match(nanBox.checks[1].actual, /bboxMin\/bboxMax 不是有限三维向量/);
});

test('变异⑧：文本实体数与回读网格数不一致（回读漏了网格）→ 产物判据红', () => {
  const { facts } = greenBaseline();
  const result = matchEntityIdentity({ ...facts, identitySolids: 4 });
  assert.equal(result.ok, false);
  assert.equal(result.checks[0].ok, false);
  assert.match(result.checks[0].actual, /文本实体数 4 ≠ 回读网格数 3/);
});

/* ---------------------------------------------------------------------------
 * 三、真 fixtures 回读（P1 生成的真实 STEP，受约于「一 solid 一 mesh」的受限格式）
 * ------------------------------------------------------------------------- */

test('真 fixture：step-identity-3parts.step 逐件回读（3 件、件号唯一、含完全被包住件）', async () => {
  const bytes = new Uint8Array(readFileSync(FIXTURE_3PARTS));
  const text = readFileSync(FIXTURE_3PARTS, 'utf8');
  const read = readStepEntities(bytes, await loadOcct());

  assert.equal(read.ok, true, read.errors.join('；'));
  assert.equal(read.entities.length, 3, 'fixture 名就是 3parts：3 个 PRODUCT 对应 3 个装配节点');
  const leaves = read.entities.map((entity) => entity.leaf);
  assert.ok(leaves.every((leaf) => typeof leaf === 'string' && leaf.length > 0), '件号叶不许为空');
  assert.equal(new Set(leaves).size, 3, '件号必须逐字唯一');
  assert.deepEqual(read.entities.map((entity) => entity.meshCount), [1, 1, 1]);
  // 受限格式的双向对照：文本实体数 == 回读网格数（不是「拿 mesh 冒充无条件实体数」）
  assert.equal(readStepManifoldSolidCount(text), read.meshCount, '文本 MANIFOLD_SOLID_BREP 数 == 回读网格数');

  const products = readStepProductNames(text);
  for (const leaf of leaves) assert.ok(products.includes(leaf), `PRODUCT 名里必须能读回件号 ${leaf}`);

  const contained = read.entities.some((outer) => read.entities.some((inner) => inner !== outer && boxInside(inner.bbox, outer.bbox)));
  assert.ok(contained, 'fixture 必须含「完全被另一件包住」的件：这正是笛卡尔顶点判据看不见、逐实体身份才看得见的那一类');

  // 纯函数判定：同目录的制造件路径只用于 sameDir 判定（真实路径归属由 CLI 用例覆盖）
  const green = matchEntityIdentity(factsFromReadback(read, {
    identityPath: FIXTURE_3PARTS,
    stepPath: resolve(FIXTURE_DIR, 'step-identity-3parts-manufacturing.step'),
    identityBytes: bytes.length
  }));
  assert.equal(green.ok, true, JSON.stringify(green.checks));
  assert.equal(green.entityIdentity.expectedParts, 3);
  assert.equal(green.entityIdentity.actualParts, 3);
});

test('真 fixture：step-identity-multisolid.step 按装配节点分组（多实体件 2 网格、无名网格不丢件号）', async () => {
  const bytes = new Uint8Array(readFileSync(FIXTURE_MULTISOLID));
  const text = readFileSync(FIXTURE_MULTISOLID, 'utf8');
  const read = readStepEntities(bytes, await loadOcct());

  assert.equal(read.ok, true, read.errors.join('；'));
  assert.ok(read.entities.length >= 2, '至少两个件（一个多实体件 + 一个单实体件）');
  const leaves = read.entities.map((entity) => entity.leaf);
  assert.ok(leaves.every((leaf) => typeof leaf === 'string' && leaf.length > 0), '路径叶必须保留件号');
  assert.equal(new Set(leaves).size, leaves.length, '件号不许重号');
  const multi = read.entities.filter((entity) => entity.meshCount > 1);
  assert.equal(multi.length, 1, '恰好一个多实体件：多实体件的网格名可能为空，靠路径叶分组才不丢');
  assert.equal(readStepManifoldSolidCount(text), read.meshCount, '文本实体数 == 回读网格数（受限格式）');

  const facts = factsFromReadback(read, {
    identityPath: FIXTURE_MULTISOLID,
    stepPath: resolve(FIXTURE_DIR, 'step-identity-multisolid-manufacturing.step'),
    identityBytes: bytes.length
  });
  const green = matchEntityIdentity(facts);
  assert.equal(green.ok, true, JSON.stringify(green.checks));

  // 变异：把两个件的实体数互换（合计与总数都不变）→ 只有逐件判据红
  const single = read.entities.find((entity) => entity.meshCount === 1);
  const multiCount = multi[0].meshCount;
  const swappedParts = facts.parts.map((part) => {
    if (part.id === multi[0].leaf) return { ...part, solids: 1 };
    if (part.id === single.leaf) return { ...part, solids: multiCount };
    return part;
  });
  const total = swappedParts.reduce((sum, part) => sum + part.solids, 0);
  assert.equal(total, facts.partSolids, '前提：合计不变');
  const swapped = matchEntityIdentity({ ...facts, parts: swappedParts, partSolids: total, identitySolids: total });
  assert.equal(swapped.ok, false);
  assert.deepEqual(swapped.checks.map((check) => check.ok), [true, true, false, true]);
  assert.ok(swapped.entityIdentity.perPartSolidsMismatch.length > 0);
});

/* ---------------------------------------------------------------------------
 * 四、纯文本证据（C8 与实体计数都得从真实 bytes 读）
 * ------------------------------------------------------------------------- */

test('readStepProductNames：只认 PRODUCT 行的名字、解码 \\X2\\ 转义、不误吞 PRODUCT_DEFINITION', () => {
  const text = [
    "#1=PRODUCT('assembly','assembly','',(#9));",
    "#2=PRODUCT('tray-01','tray-01','',(#9));",
    "#3=PRODUCT('\\X2\\4F3A670D7535673A\\X0\\_400W','x','',(#9));",
    "#4=PRODUCT('it''s','it''s','',(#9));",
    "#5=PRODUCT_DEFINITION('tray-01',#6,#7);",
    "#6=PRODUCT_DEFINITION_FORMATION('','',#1);"
  ].join('\n');
  const names = readStepProductNames(text);
  assert.deepEqual(names, ['assembly', 'tray-01', '伺服电机_400W', "it's"]);
  assert.equal(decodeStepString(''), '');
});

test('readStepManifoldSolidCount：只数 MANIFOLD_SOLID_BREP 实体（不看自报的 products/solids）', () => {
  const text = [
    '#1=MANIFOLD_SOLID_BREP(\'\',#2);',
    '#2=MANIFOLD_SOLID_BREP(\'\',#3);',
    '#3=ADVANCED_BREP_SHAPE_REPRESENTATION(\'\',(#1),#9);',
    '#4=MANIFOLD_SOLID_BREP_GHOST(\'\',#5);'
  ].join('\n');
  assert.equal(readStepManifoldSolidCount(text), 2);
  assert.equal(readStepManifoldSolidCount(''), 0);
});

/* ---------------------------------------------------------------------------
 * 三、C7 同口径包络：旧口径（拓扑 VERTEX_POINT 包络）必红，同口径（网格包络）必绿
 *
 * 真塔 16 层实测的失败长这样：identity 网格包络 y=800、制造 STEP 的拓扑顶点包络 y=780，
 * 按 1mm 比 → 差 19.85mm（正好是 Ø40 回转体的半径）。圆柱面上真正的极值点不是拓扑顶点
 * （整圆只有一条缝合线上的两个 VERTEX_POINT，y 恒为圆心），所以那不是几何差，是**量纲错配**。
 *
 * 这里内联一份真实小 STEP（不是桩文本）：build123d 0.13.0 导出的 Ø40×40 圆柱，
 * 装配根 assembly、叶 cyl-mast；无内核也能回读。为什么内联而不是放 fixtures 目录：
 * 本轮白名单只许改四个文件、不新增文件；内容是真 STEP bytes，回读路径与真 fixture 一致。
 * ------------------------------------------------------------------------- */

/** 真 STEP：单件 Ø40×40 圆柱（label=cyl-mast）。曲面极值 y=±19.995，拓扑顶点只有 y=0。 */
const CURVED_IDENTITY_STEP = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('Open CASCADE Model'),'2;1');
FILE_NAME('assembly','2026-11-19T22:58:04',('Author'),('Open CASCADE'),
  'Open CASCADE STEP processor 8.0','build123d','Unknown');
FILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }'));
ENDSEC;
DATA;
#1 = APPLICATION_PROTOCOL_DEFINITION('international standard',
  'automotive_design',2000,#2);
#2 = APPLICATION_CONTEXT(
  'core data for automotive mechanical design processes');
#3 = SHAPE_DEFINITION_REPRESENTATION(#4,#10);
#4 = PRODUCT_DEFINITION_SHAPE('','',#5);
#5 = PRODUCT_DEFINITION('design','',#6,#9);
#6 = PRODUCT_DEFINITION_FORMATION('','',#7);
#7 = PRODUCT('assembly','assembly','',(#8));
#8 = PRODUCT_CONTEXT('',#2,'mechanical');
#9 = PRODUCT_DEFINITION_CONTEXT('part definition',#2,'design');
#10 = SHAPE_REPRESENTATION('',(#11,#15),#19);
#11 = AXIS2_PLACEMENT_3D('',#12,#13,#14);
#12 = CARTESIAN_POINT('',(0.,0.,0.));
#13 = DIRECTION('',(0.,0.,1.));
#14 = DIRECTION('',(1.,0.,-0.));
#15 = AXIS2_PLACEMENT_3D('',#16,#17,#18);
#16 = CARTESIAN_POINT('',(0.,0.,0.));
#17 = DIRECTION('',(0.,0.,1.));
#18 = DIRECTION('',(1.,0.,-0.));
#19 = ( GEOMETRIC_REPRESENTATION_CONTEXT(3) 
GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT((#23)) GLOBAL_UNIT_ASSIGNED_CONTEXT(
(#20,#21,#22)) REPRESENTATION_CONTEXT('Context #1',
  '3D Context with UNIT and UNCERTAINTY') );
#20 = ( LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT(.MILLI.,.METRE.) );
#21 = ( NAMED_UNIT(*) PLANE_ANGLE_UNIT() SI_UNIT($,.RADIAN.) );
#22 = ( NAMED_UNIT(*) SI_UNIT($,.STERADIAN.) SOLID_ANGLE_UNIT() );
#23 = UNCERTAINTY_MEASURE_WITH_UNIT(LENGTH_MEASURE(1.E-07),#20,
  'distance_accuracy_value','confusion accuracy');
#24 = PRODUCT_RELATED_PRODUCT_CATEGORY('part',$,(#7));
#25 = SHAPE_DEFINITION_REPRESENTATION(#26,#32);
#26 = PRODUCT_DEFINITION_SHAPE('','',#27);
#27 = PRODUCT_DEFINITION('design','',#28,#31);
#28 = PRODUCT_DEFINITION_FORMATION('','',#29);
#29 = PRODUCT('cyl-mast','cyl-mast','',(#30));
#30 = PRODUCT_CONTEXT('',#2,'mechanical');
#31 = PRODUCT_DEFINITION_CONTEXT('part definition',#2,'design');
#32 = ADVANCED_BREP_SHAPE_REPRESENTATION('',(#11,#33),#131);
#33 = MANIFOLD_SOLID_BREP('',#34);
#34 = CLOSED_SHELL('',(#35,#123,#127));
#35 = ADVANCED_FACE('',(#36),#49,.T.);
#36 = FACE_BOUND('',#37,.T.);
#37 = EDGE_LOOP('',(#38,#72,#95,#122));
#38 = ORIENTED_EDGE('',*,*,#39,.F.);
#39 = EDGE_CURVE('',#40,#40,#42,.T.);
#40 = VERTEX_POINT('',#41);
#41 = CARTESIAN_POINT('',(20.,-4.898587196589E-15,40.));
#42 = SURFACE_CURVE('',#43,(#48,#60),.PCURVE_S1.);
#43 = CIRCLE('',#44,20.);
#44 = AXIS2_PLACEMENT_3D('',#45,#46,#47);
#45 = CARTESIAN_POINT('',(0.,0.,40.));
#46 = DIRECTION('',(0.,0.,1.));
#47 = DIRECTION('',(1.,0.,-0.));
#48 = PCURVE('',#49,#54);
#49 = CYLINDRICAL_SURFACE('',#50,20.);
#50 = AXIS2_PLACEMENT_3D('',#51,#52,#53);
#51 = CARTESIAN_POINT('',(0.,0.,0.));
#52 = DIRECTION('',(0.,0.,1.));
#53 = DIRECTION('',(1.,0.,-0.));
#54 = DEFINITIONAL_REPRESENTATION('',(#55),#59);
#55 = LINE('',#56,#57);
#56 = CARTESIAN_POINT('',(0.,40.));
#57 = VECTOR('',#58,1.);
#58 = DIRECTION('',(1.,0.));
#59 = ( GEOMETRIC_REPRESENTATION_CONTEXT(2) 
PARAMETRIC_REPRESENTATION_CONTEXT() REPRESENTATION_CONTEXT('2D SPACE',''
  ) );
#60 = PCURVE('',#61,#66);
#61 = PLANE('',#62);
#62 = AXIS2_PLACEMENT_3D('',#63,#64,#65);
#63 = CARTESIAN_POINT('',(0.,0.,40.));
#64 = DIRECTION('',(0.,0.,1.));
#65 = DIRECTION('',(1.,0.,-0.));
#66 = DEFINITIONAL_REPRESENTATION('',(#67),#71);
#67 = CIRCLE('',#68,20.);
#68 = AXIS2_PLACEMENT_2D('',#69,#70);
#69 = CARTESIAN_POINT('',(0.,0.));
#70 = DIRECTION('',(1.,0.));
#71 = ( GEOMETRIC_REPRESENTATION_CONTEXT(2) 
PARAMETRIC_REPRESENTATION_CONTEXT() REPRESENTATION_CONTEXT('2D SPACE',''
  ) );
#72 = ORIENTED_EDGE('',*,*,#73,.F.);
#73 = EDGE_CURVE('',#74,#40,#76,.T.);
#74 = VERTEX_POINT('',#75);
#75 = CARTESIAN_POINT('',(20.,-4.898587196589E-15,0.));
#76 = SEAM_CURVE('',#77,(#81,#88),.PCURVE_S1.);
#77 = LINE('',#78,#79);
#78 = CARTESIAN_POINT('',(20.,-4.898587196589E-15,0.));
#79 = VECTOR('',#80,1.);
#80 = DIRECTION('',(0.,0.,1.));
#81 = PCURVE('',#49,#82);
#82 = DEFINITIONAL_REPRESENTATION('',(#83),#87);
#83 = LINE('',#84,#85);
#84 = CARTESIAN_POINT('',(6.28318530718,-0.));
#85 = VECTOR('',#86,1.);
#86 = DIRECTION('',(0.,1.));
#87 = ( GEOMETRIC_REPRESENTATION_CONTEXT(2) 
PARAMETRIC_REPRESENTATION_CONTEXT() REPRESENTATION_CONTEXT('2D SPACE',''
  ) );
#88 = PCURVE('',#49,#89);
#89 = DEFINITIONAL_REPRESENTATION('',(#90),#94);
#90 = LINE('',#91,#92);
#91 = CARTESIAN_POINT('',(0.,-0.));
#92 = VECTOR('',#93,1.);
#93 = DIRECTION('',(0.,1.));
#94 = ( GEOMETRIC_REPRESENTATION_CONTEXT(2) 
PARAMETRIC_REPRESENTATION_CONTEXT() REPRESENTATION_CONTEXT('2D SPACE',''
  ) );
#95 = ORIENTED_EDGE('',*,*,#96,.T.);
#96 = EDGE_CURVE('',#74,#74,#97,.T.);
#97 = SURFACE_CURVE('',#98,(#103,#110),.PCURVE_S1.);
#98 = CIRCLE('',#99,20.);
#99 = AXIS2_PLACEMENT_3D('',#100,#101,#102);
#100 = CARTESIAN_POINT('',(0.,0.,0.));
#101 = DIRECTION('',(0.,0.,1.));
#102 = DIRECTION('',(1.,0.,-0.));
#103 = PCURVE('',#49,#104);
#104 = DEFINITIONAL_REPRESENTATION('',(#105),#109);
#105 = LINE('',#106,#107);
#106 = CARTESIAN_POINT('',(0.,0.));
#107 = VECTOR('',#108,1.);
#108 = DIRECTION('',(1.,0.));
#109 = ( GEOMETRIC_REPRESENTATION_CONTEXT(2) 
PARAMETRIC_REPRESENTATION_CONTEXT() REPRESENTATION_CONTEXT('2D SPACE',''
  ) );
#110 = PCURVE('',#111,#116);
#111 = PLANE('',#112);
#112 = AXIS2_PLACEMENT_3D('',#113,#114,#115);
#113 = CARTESIAN_POINT('',(0.,0.,0.));
#114 = DIRECTION('',(0.,0.,1.));
#115 = DIRECTION('',(1.,0.,-0.));
#116 = DEFINITIONAL_REPRESENTATION('',(#117),#121);
#117 = CIRCLE('',#118,20.);
#118 = AXIS2_PLACEMENT_2D('',#119,#120);
#119 = CARTESIAN_POINT('',(0.,0.));
#120 = DIRECTION('',(1.,0.));
#121 = ( GEOMETRIC_REPRESENTATION_CONTEXT(2) 
PARAMETRIC_REPRESENTATION_CONTEXT() REPRESENTATION_CONTEXT('2D SPACE',''
  ) );
#122 = ORIENTED_EDGE('',*,*,#73,.T.);
#123 = ADVANCED_FACE('',(#124),#61,.T.);
#124 = FACE_BOUND('',#125,.T.);
#125 = EDGE_LOOP('',(#126));
#126 = ORIENTED_EDGE('',*,*,#39,.T.);
#127 = ADVANCED_FACE('',(#128),#111,.F.);
#128 = FACE_BOUND('',#129,.T.);
#129 = EDGE_LOOP('',(#130));
#130 = ORIENTED_EDGE('',*,*,#96,.F.);
#131 = ( GEOMETRIC_REPRESENTATION_CONTEXT(3) 
GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT((#135)) GLOBAL_UNIT_ASSIGNED_CONTEXT
((#132,#133,#134)) REPRESENTATION_CONTEXT('Context #1',
  '3D Context with UNIT and UNCERTAINTY') );
#132 = ( LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT(.MILLI.,.METRE.) );
#133 = ( NAMED_UNIT(*) PLANE_ANGLE_UNIT() SI_UNIT($,.RADIAN.) );
#134 = ( NAMED_UNIT(*) SI_UNIT($,.STERADIAN.) SOLID_ANGLE_UNIT() );
#135 = UNCERTAINTY_MEASURE_WITH_UNIT(LENGTH_MEASURE(1.E-07),#132,
  'distance_accuracy_value','confusion accuracy');
#136 = CONTEXT_DEPENDENT_SHAPE_REPRESENTATION(#137,#139);
#137 = ( REPRESENTATION_RELATIONSHIP('','',#32,#10) 
REPRESENTATION_RELATIONSHIP_WITH_TRANSFORMATION(#138) 
SHAPE_REPRESENTATION_RELATIONSHIP() );
#138 = ITEM_DEFINED_TRANSFORMATION('','',#11,#15);
#139 = PRODUCT_DEFINITION_SHAPE('Placement','Placement of an item',#140
  );
#140 = NEXT_ASSEMBLY_USAGE_OCCURRENCE('1','cyl-mast','',#5,#27,$);
#141 = PRODUCT_RELATED_PRODUCT_CATEGORY('part',$,(#29));
ENDSEC;
END-ISO-10303-21;
`;

/** 制造侧同源替身仅验证同口径读数与判据方向，不证明 fuse 与 compound 拓扑等价。 */
function mergedStepText(text) {
  return text.replace(/PRODUCT\('([^']*)','\1'/g, "PRODUCT('COMPOUND','COMPOUND'");
}

/** 旧口径复刻：拓扑 VERTEX_POINT 包络（与 inspectStep 的 bbox 同源，纯文本解析）。 */
function vertexPointBox(text) {
  const points = new Map();
  const pointRe = /#(\d+)\s*=\s*CARTESIAN_POINT\s*\(\s*'[^']*'\s*,\s*\(\s*([-\d.E+]+)\s*,\s*([-\d.E+]+)\s*,\s*([-\d.E+]+)\s*\)/g;
  for (const match of text.matchAll(pointRe)) {
    points.set(match[1], [Number(match[2]), Number(match[3]), Number(match[4])]);
  }
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  let count = 0;
  for (const match of text.matchAll(/VERTEX_POINT\s*\(\s*'[^']*'\s*,\s*#(\d+)/g)) {
    const point = points.get(match[1]);
    if (!point) continue;
    count += 1;
    for (let axis = 0; axis < 3; axis += 1) {
      if (point[axis] < min[axis]) min[axis] = point[axis];
      if (point[axis] > max[axis]) max[axis] = point[axis];
    }
  }
  return count > 0 ? { min, max, count } : null;
}

function curvedFixture() {
  const identityBytes = Buffer.from(CURVED_IDENTITY_STEP, 'utf8');
  const mergedText = mergedStepText(CURVED_IDENTITY_STEP);
  const mergedBytes = Buffer.from(mergedText, 'utf8');
  return { identityBytes, mergedText, mergedBytes };
}

test('C7：同口径网格包络取到曲面极值，拓扑顶点包络取不到（旧口径缺口≈半径）', async () => {
  const occt = await loadOcct();
  const { mergedBytes, mergedText } = curvedFixture();

  const envelope = readStepMeshEnvelope(new Uint8Array(mergedBytes), occt);
  assert.equal(envelope.ok, true, envelope.errors.join('；'));
  assert.equal(envelope.meshCount, 1);
  assert.ok(Math.abs(envelope.bbox.max[1] - 19.995) < 0.01, `网格包络 y max=${envelope.bbox.max[1]}`);
  assert.ok(Math.abs(envelope.bbox.min[1] + 19.995) < 0.01, `网格包络 y min=${envelope.bbox.min[1]}`);

  const topology = vertexPointBox(mergedText);
  assert.ok(topology, '这份 fixture 必须有拓扑顶点（缝合线两端）');
  assert.ok(Math.abs(topology.max[1]) < 1e-6, `拓扑顶点 y 全在圆心 0（实测 ${topology.max[1]}）`);
  assert.ok(
    envelope.bbox.max[1] - topology.max[1] > 19,
    '曲面极值不在拓扑顶点上 —— 这正是旧口径系统性缩小一个半径的原因'
  );
});

test('C7：喂拓扑顶点包络当制造包络 → 第 4 条必红（19.9mm，容差 1mm 不放宽）', async () => {
  const occt = await loadOcct();
  const { identityBytes, mergedBytes, mergedText } = curvedFixture();
  const readback = readStepEntities(new Uint8Array(identityBytes), occt);
  assert.equal(readback.ok, true, readback.errors.join('；'));
  assert.equal(readback.entities.length, 1);
  assert.equal(readback.entities[0].leaf, 'cyl-mast');

  const envelope = readStepMeshEnvelope(new Uint8Array(mergedBytes), occt);
  const entity = readback.entities[0];
  const parts = [{ id: 'cyl-mast', bboxMin: [...entity.bbox.min], bboxMax: [...entity.bbox.max], solids: 1 }];
  const base = {
    partTableIds: ['cyl-mast'],
    parts,
    readback,
    identitySolids: 1,
    partSolids: 1,
    mergedProductNames: ['COMPOUND'],
    identityPath: '/build/identity.step',
    stepPath: '/build/step.step',
    identityBytes: identityBytes.length
  };

  // 旧口径：拓扑顶点包络（y 只到 0）当制造整体包络 → 与 identity 网格包络差 ~19.99mm → 红
  const oldCaliber = matchEntityIdentity({ ...base, mergedBBox: vertexPointBox(mergedText) });
  assert.equal(oldCaliber.ok, false, '旧口径必须红：这正是 16 层真塔 26/27 的那一条');
  assert.equal(oldCaliber.checks[3].ok, false);
  assert.match(oldCaliber.checks[3].actual, /并集超差/);
  assert.ok(oldCaliber.entityIdentity.unionDeltaMm[1] > 19, `y 差应≈半径，实测 ${oldCaliber.entityIdentity.unionDeltaMm}`);

  // 同口径：两侧都是网格包络（同一份 occt 回读参数）→ Δ=0，绿
  const sameCaliber = matchEntityIdentity({
    ...base,
    mergedBBox: envelope.bbox,
    mergedReadbackMeshCount: envelope.meshCount,
    mergedReadbackErrors: envelope.errors,
    mergedVertexPointBBox: vertexPointBox(mergedText)
  });
  assert.equal(sameCaliber.ok, true, JSON.stringify(sameCaliber.checks));
  assert.deepEqual(sameCaliber.entityIdentity.unionDeltaMm.map((value) => Number(value.toFixed(3))), [0, 0, 0]);
  assert.ok(sameCaliber.entityIdentity.identityBBox, 'JSON 必须给出 identityBBox');
  assert.ok(sameCaliber.entityIdentity.mergedReadbackBBox, 'JSON 必须给出 mergedReadbackBBox');
  assert.equal(sameCaliber.entityIdentity.mergedReadbackMeshCount, 1);
  // 旧口径包络仍在 JSON 里（只作参考），差值一眼可见
  assert.ok(sameCaliber.entityIdentity.mergedVertexPointBBox);
  assert.ok(Math.abs(sameCaliber.entityIdentity.mergedVertexPointBBox.max[1]) < 1e-6);
});

test('C7：制造 STEP 导入失败 → 第 4 条判红并点名，不退回旧口径、不跳过', async () => {
  const occt = await loadOcct();
  const { identityBytes } = curvedFixture();
  const readback = readStepEntities(new Uint8Array(identityBytes), occt);
  const entity = readback.entities[0];
  const parts = [{ id: 'cyl-mast', bboxMin: [...entity.bbox.min], bboxMax: [...entity.bbox.max], solids: 1 }];
  const base = {
    partTableIds: ['cyl-mast'],
    parts,
    readback,
    identitySolids: 1,
    partSolids: 1,
    mergedProductNames: ['COMPOUND'],
    identityPath: '/build/identity.step',
    stepPath: '/build/step.step',
    identityBytes: identityBytes.length
  };

  const broken = readStepMeshEnvelope(new Uint8Array(Buffer.from('not a step file', 'utf8')), occt);
  assert.equal(broken.ok, false);
  assert.equal(broken.bbox, null, '导入失败不许给出包络');
  assert.ok(broken.errors.length > 0);

  const red = matchEntityIdentity({
    ...base,
    mergedBBox: broken.ok ? broken.bbox : null,
    mergedVertexPointBBox: readback.bbox, // 故意给出可用旧包络，缺网格侧仍不得回退。
    mergedReadbackErrors: broken.errors,
    mergedReadbackMeshCount: broken.meshCount
  });
  assert.equal(red.ok, false);
  assert.equal(red.checks[3].ok, false);
  assert.match(red.checks[3].actual, /同口径回读失败|导入失败/);
  assert.deepEqual(red.entityIdentity.mergedReadbackErrors, broken.errors, '失败原因必须进 JSON');
  assert.equal(red.entityIdentity.mergedReadbackBBox, null);
  assert.equal(red.entityIdentity.unionDeltaMm, null, '制造侧回读失败不得回退拓扑包络伪造零差');
});

test('C7：readStepMeshEnvelope 结构错误（0 网格 / 坏 indices / NaN / success=false）一律 ok=false', () => {
  const okMesh = boxMesh([0, 0, 0], [10, 10, 10]);
  const badIndex = { ...boxMesh([0, 0, 0], [10, 10, 10]), index: { array: [0, 1, 999] } };
  const nanMesh = boxMesh([0, 0, 0], [10, 10, 10]);
  nanMesh.attributes.position.array = [...nanMesh.attributes.position.array];
  nanMesh.attributes.position.array[1] = Number.NaN;

  const cases = [
    ['0 网格', { ReadStepFile: () => ({ success: true, meshes: [], root: treeNode('x') }) }],
    ['success=false', { ReadStepFile: () => ({ success: false, meshes: [okMesh], root: treeNode('x') }) }],
    ['坏 indices', { ReadStepFile: () => ({ success: true, meshes: [badIndex], root: treeNode('x') }) }],
    ['NaN 顶点', { ReadStepFile: () => ({ success: true, meshes: [nanMesh], root: treeNode('x') }) }],
    ['抛错', { ReadStepFile: () => { throw new Error('boom'); } }]
  ];
  for (const [label, fake] of cases) {
    const envelope = readStepMeshEnvelope(new Uint8Array([0]), fake);
    assert.equal(envelope.ok, false, `${label} 必须 ok=false`);
    assert.equal(envelope.bbox, null, `${label} 不许给出包络`);
    assert.ok(envelope.errors.length > 0, `${label} 必须说明原因`);
  }
});

/* ---------------------------------------------------------------------------
 * 四、P1-2 路径归属（realpath / 软链 / `./`）与 P1-3 容差、P2-3 计数闭包
 * ------------------------------------------------------------------------- */

test('P1-2：真实路径优先 —— 软链把 identity 藏到别的目录 → 红；软链指回制造 STEP → 红', () => {
  const { facts } = greenBaseline();

  // 字符串层面同目录（/b/identity.step vs /b/step.step），真实路径在另一目录 → 必须红
  const escaped = matchEntityIdentity({
    ...facts,
    identityPath: '/b/identity.step',
    stepPath: '/b/step.step',
    identityRealPath: '/elsewhere/identity.step',
    stepRealPath: '/b/step.step'
  });
  assert.equal(escaped.ok, false);
  assert.equal(escaped.entityIdentity.sameDir, false);
  assert.match(escaped.checks[0].actual, /不同目录/);

  // 软链指回制造 STEP 自身：真实路径相同 → 红（旧实现只比字符串，能绕）
  const self = matchEntityIdentity({
    ...facts,
    identityPath: '/b/identity-link.step',
    stepPath: '/b/step.step',
    identityRealPath: '/b/step.step',
    stepRealPath: '/b/step.step'
  });
  assert.equal(self.ok, false);
  assert.match(self.checks[0].actual, /制造 STEP 自身/);

  // identity 自身是符号链接 → 真实归属不可信，直接红
  const link = matchEntityIdentity({ ...facts, identityPathIsSymlink: true });
  assert.equal(link.ok, false);
  assert.match(link.checks[0].actual, /符号链接/);

  // `./` 只是写法差异，不许假红
  const dotted = matchEntityIdentity({
    ...facts,
    identityPath: '/b/./identity.step',
    stepPath: '/b/step.step'
  });
  assert.equal(dotted.ok, true, JSON.stringify(dotted.checks));
  assert.equal(dotted.entityIdentity.sameDir, true);
});

test('P1-3：身份容差固定 1mm —— CLI 放大无效（19.85mm 缺口仍红），只许收紧', () => {
  const { facts } = greenBaseline();
  const squeezed = {
    ...facts,
    mergedBBox: { min: [...facts.mergedBBox.min], max: [...facts.mergedBBox.max] }
  };
  squeezed.mergedBBox.max[1] = squeezed.mergedBBox.max[1] + 19.85;

  assert.equal(matchEntityIdentity(squeezed).ok, false, '1mm 下 19.85mm 缺口必红');

  const amplified = matchEntityIdentity({ ...squeezed, toleranceMm: 20 });
  assert.equal(amplified.entityIdentity.toleranceMm, 1, '身份容差钉在 1mm');
  assert.equal(amplified.entityIdentity.tolerancePolicy, 'capped');
  assert.equal(amplified.entityIdentity.requestedToleranceMm, 20);
  assert.equal(amplified.ok, false, '--tolerance 20 不许把 19.85mm 判绿（这正是假修路径）');

  const tightened = matchEntityIdentity({ ...facts, toleranceMm: 0.5 });
  assert.equal(tightened.entityIdentity.toleranceMm, 0.5);
  assert.equal(tightened.entityIdentity.tolerancePolicy, 'tightened');
});

test('P2-1：非法容差（NaN / Infinity / 负数 / 非数字）判红，不静默兜底成 1mm 假绿', () => {
  const { facts } = greenBaseline();
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1, '1']) {
    const result = matchEntityIdentity({ ...facts, toleranceMm: bad });
    assert.equal(result.ok, false, `tolerance=${String(bad)} 必须判红`);
    assert.ok(result.entityIdentity.toleranceError, `tolerance=${String(bad)} 必须给出原因`);
    assert.equal(result.checks[2].ok, false);
    assert.equal(result.checks[3].ok, false);
  }
});

test('P2-3：Σ节点网格数 ≠ 回读网格数 → 产物判据红（不再只靠传递闭包）', () => {
  const { facts } = greenBaseline();
  const forged = {
    ...facts,
    readback: {
      ...facts.readback,
      entities: facts.readback.entities.map((entity, index) => (
        index === 0 ? { ...entity, meshCount: 0 } : entity
      ))
    }
  };
  const result = matchEntityIdentity(forged);
  assert.equal(result.ok, false);
  assert.match(result.checks[0].actual, /Σ节点网格数 2 ≠ 回读网格数 3/);
});
