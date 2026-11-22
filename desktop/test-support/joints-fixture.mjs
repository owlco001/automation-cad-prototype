// Shared fixtures for the joint-rule optimization.
//
// The sparse fixture intentionally has no rule-matching IDs (the existing
// clearance fixture), while the named fixture exercises every naming rule and
// sensor stem. `dense` only moves the same parts closer; IDs stay unchanged so
// connection matching and report equivalence can be measured independently.

import { clearanceFixture } from './clearance-fixture.mjs';

export const REAL_MACHINE_BRIEFS = [
  '设计一台三工位锁螺丝机，节拍 20 件/分钟，用 750W 伺服',
  '两工位装配机，节拍 10 件/分钟，安全光栅 2 个',
  '光伏板加工输送机：输送 2000mm 光伏板，线体长 6000mm、带宽 1200mm，需要把光伏板旋转 90° 改变方向，节拍 6 件/分钟',
  '光伏板加工输送机：输送 1200×800mm 光伏板，线体长 3000mm、带宽 1200mm，需要顶升移载沿 90° 方向把板子送到下游输送线，节拍 6 件/分钟'
];

/**
 * Assign IDs that hit all six rules, every sensor stem role, and a few
 * non-participants. Within each 16-part block:
 *   frame legs/stringers, station upright/plate/beam, actuator mount/body,
 *   sensor bracket/body/tx, and one special conveyor/frame-top slot.
 */
export function nameJointParts(parts) {
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (!part) continue;
    const block = Math.floor(index / 16);
    const slot = index % 16;
    if (slot < 3) part.id = `frame-leg-${index}`;
    else if (slot < 5) part.id = `frame-stringer-${index}`;
    else if (slot < 7) part.id = `st${index}-upright-${index % 2 === 0 ? 'l' : 'r'}`;
    else if (slot < 9) part.id = `st${index}-plate`;
    else if (slot === 9) part.id = `st${index}-beam`;
    else if (slot === 10) part.id = `act-${index}-mount`;
    else if (slot === 11) part.id = `act-${index}-body`;
    else if (slot === 12) part.id = `sensor-${block}-bracket`;
    else if (slot === 13) part.id = `sensor-${block}`;
    else if (slot === 14) part.id = `sensor-${block}-tx`;
    else if (index === 15) part.id = 'frame-top';
    else if (index === 31) part.id = 'conveyor-frame';
    else if (index === 47) part.id = 'conveyor-belt';
    else if (index === 63) part.id = 'conveyor-motor';
    else part.id = `misc-${index}`;
  }
  return parts;
}

/** Rule-matching IDs on the sparse clearance geometry. */
export function namedJointFixture(count) {
  const geometry = clearanceFixture(count);
  nameJointParts(geometry.parts);
  return geometry;
}

/** Existing dense arrangement: divide all centres by 5 (same IDs/shapes). */
export function denseFixture(count) {
  const geometry = clearanceFixture(count);
  for (const part of geometry.parts) part.center = part.center.map(value => value / 5);
  return geometry;
}

/** Rule-matching IDs plus the dense arrangement. */
export function namedDenseJointFixture(count) {
  const geometry = namedJointFixture(count);
  for (const part of geometry.parts) part.center = part.center.map(value => value / 5);
  return geometry;
}
