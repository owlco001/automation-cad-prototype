import assert from 'node:assert/strict';
import { test } from 'node:test';
import { featureWorkbench, mountFeatureWorkbench, releaseFeatureWorkbench } from '../../src/canvas/feature-tree-mount.ts';

function demoDoc(extra = 0) {
  return {
    schemaVersion: 1,
    features: [
      { id: 'f-body', type: 'box', name: '板体', params: { length: 90 + extra, width: 90, height: 12 } },
      { id: 'f-cb', type: 'counterbore', name: '沉头孔', params: { diameter: 5.5, cbDiameter: 8.5, cbDepth: 5 } }
    ],
    updatedAt: '2026-10-28T00:00:00.000Z'
  };
}

/** 记录所有监听器的假容器，用来断言"重复挂载不叠加监听"。 */
function fakeContainer() {
  const handlers = { click: [], change: [] };
  return {
    innerHTML: '',
    handlers,
    addEventListener(type, listener) {
      (handlers[type] ??= []).push(listener);
    },
    removeEventListener(type, listener) {
      handlers[type] = (handlers[type] ?? []).filter((item) => item !== listener);
    },
    fire(type, event) {
      for (const handler of handlers[type] ?? []) handler(event);
    }
  };
}

const clickOn = (id) => ({ target: { closest: () => ({ dataset: { treeId: id } }) } });

test('幂等挂载：重复调用同一容器只挂一次监听，文档被替换', () => {
  const tree = fakeContainer();
  const panel = fakeContainer();
  featureWorkbench(demoDoc(), { tree, panel });
  featureWorkbench(demoDoc(10), { tree, panel });
  featureWorkbench(demoDoc(20), { tree, panel });
  assert.equal(tree.handlers.click.length, 1);
  assert.equal(panel.handlers.change.length, 1);
  assert.ok(tree.innerHTML.length > 0);
});

test('幂等挂载：重新挂载保留选中项，文档里没有该特征则清空', () => {
  const tree = fakeContainer();
  const panel = fakeContainer();
  const mounted = featureWorkbench(demoDoc(), { tree, panel });
  tree.fire('click', clickOn('f-cb'));
  assert.equal(mounted.getSelectedId(), 'f-cb');
  featureWorkbench(demoDoc(5), { tree, panel });
  assert.equal(mounted.getSelectedId(), 'f-cb', '同一份特征还在时不该丢选中');
  featureWorkbench({ ...demoDoc(), features: [demoDoc().features[0]] }, { tree, panel });
  assert.equal(mounted.getSelectedId(), null);
  assert.ok(panel.innerHTML.includes('未选中特征'));
});

test('面板输入框 change 走校验写回：合法值改文档，非法值不动', () => {
  const tree = fakeContainer();
  const panel = fakeContainer();
  const changed = [];
  const mounted = mountFeatureWorkbench(demoDoc(), {
    tree,
    panel,
    onDocChange: (next) => changed.push(next)
  });
  tree.fire('click', clickOn('f-cb'));
  assert.ok(panel.innerHTML.includes('data-edit-key="cbDiameter"'), '可编辑字段要渲染成输入框');

  panel.fire('change', { target: { value: '9.5', dataset: { editKey: 'cbDiameter', valueType: 'number' } } });
  assert.equal(changed.length, 1);
  assert.equal(mounted.getDoc().features[1].params.cbDiameter, 9.5);

  // 沉窝直径必须大于孔径：给 5.5 应被拦下
  panel.fire('change', { target: { value: '5.5', dataset: { editKey: 'cbDiameter', valueType: 'number' } } });
  assert.equal(changed.length, 1);
  assert.equal(mounted.getDoc().features[1].params.cbDiameter, 9.5);

  // 非数字文本不能变成 NaN 写进模型
  panel.fire('change', { target: { value: 'abc', dataset: { editKey: 'cbDepth', valueType: 'number' } } });
  assert.equal(mounted.getDoc().features[1].params.cbDepth, 5);
});

test('派生字段（孔数 count）保持只读，不渲染输入框', () => {
  const tree = fakeContainer();
  const panel = fakeContainer();
  mountFeatureWorkbench(
    {
      schemaVersion: 1,
      features: [
        { id: 'f-holes', type: 'holes', name: '安装孔', params: { diameter: 6, positions: [[0, 0], [20, 0]] } }
      ],
      updatedAt: '2026-10-28T00:00:00.000Z'
    },
    { tree, panel }
  );
  tree.fire('click', clickOn('f-holes'));
  assert.ok(panel.innerHTML.includes('孔数'));
  assert.ok(!panel.innerHTML.includes('data-edit-key="count"'));
});

test('卸载：监听器移除、容器清空，再挂载可以重新绑定', () => {
  const tree = fakeContainer();
  const panel = fakeContainer();
  mountFeatureWorkbench(demoDoc(), { tree, panel });
  releaseFeatureWorkbench(tree);
  releaseFeatureWorkbench(panel);
  assert.equal(tree.handlers.click.length, 0);
  assert.equal(panel.handlers.change.length, 0);
  assert.equal(tree.innerHTML, '');
  mountFeatureWorkbench(demoDoc(), { tree, panel });
  assert.equal(tree.handlers.click.length, 1);
});
