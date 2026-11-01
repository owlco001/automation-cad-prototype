import assert from 'node:assert/strict';
import test from 'node:test';
import { registerLinkagePoseBridge } from '../../src/commission/linkage-bridge.ts';

const scene = () => {
  const calls = [];
  return { calls, applyLinkagePose(pose) { calls.push(pose); return Object.keys(pose?.offsets ?? {}).length; } };
};

test('桥接把位姿转给当前场景', () => {
  const win = {};
  const a = scene();
  registerLinkagePoseBridge(win, () => a);
  win.__cadApplyLinkagePose({ offsets: { 'st1-gripper-1': [0, 0, -20] }, rotZDeg: { 'st1-rotary-1': 90 } });
  assert.equal(a.calls.length, 1);
  assert.deepEqual(a.calls[0].offsets['st1-gripper-1'], [0, 0, -20]);
});

test('视口重建后仍指向新场景（不闭包旧实例）', () => {
  const win = {};
  let current = scene();
  registerLinkagePoseBridge(win, () => current);
  win.__cadApplyLinkagePose({ offsets: { a: [1, 0, 0] } });
  const rebuilt = scene();
  current = rebuilt;                       // 模拟 dispose + 新建
  win.__cadApplyLinkagePose({ offsets: { b: [2, 0, 0] } });
  assert.equal(current.calls.length, 1);
  assert.deepEqual(current.calls[0].offsets.b, [2, 0, 0]);
});

test('场景不存在时不抛错（面板先点、视口后建）', () => {
  const win = {};
  registerLinkagePoseBridge(win, () => null);
  assert.doesNotThrow(() => win.__cadApplyLinkagePose({ offsets: {} }));
});
