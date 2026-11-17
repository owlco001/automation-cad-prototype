import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseProjectSnapshot, parseProjectViewState, MAX_PROJECT_SNAPSHOT_BYTES } from '../../src/project-session/snapshot.ts';
import { demoMachineConfig } from '../../src/commission/machine-config.ts';
import { parseMachineBrief } from '../../src/machine/spec.ts';
import { synthMachine } from '../../src/machine/synth.ts';
import { validateMachineDesign } from '../../src/machine/store.ts';
import { buildConveyorParts, conveyorAssembly } from '../../src/machine/conveyor-assembly.ts';

const view = () => ({ schemaVersion: 1, position: [10, 20, 30], target: [0, 0, 0], up: [0, 0, 1], fovDeg: 45, wireframe: false });
const snapshot = () => ({ schemaVersion: 1, projectId: 'local-session-binding', sourceName: 'machine.step', machineConfig: null, machineDesign: null, featureTreeJson: null, kinematicsJson: null, viewState: view(), meshSignature: 'ab'.repeat(32), ioPoints: null });

test('snapshot validates and deep clones nullable state and machine configuration', () => {
  const input = snapshot();
  input.machineConfig = demoMachineConfig();
  const parsed = parseProjectSnapshot(input);
  assert.deepEqual(parsed, input);
  parsed.viewState.position[0] = 999;
  parsed.machineConfig.stations[0] = 'changed';
  assert.equal(input.viewState.position[0], 10);
  assert.notEqual(input.machineConfig.stations[0], 'changed');
});

test('stored machine design validates and clones nested BOM/configuration data', () => {
  const design = validateMachineDesign(synthMachine(parseMachineBrief('设计一台三工位锁螺丝机，节拍 20 件/分钟，用 750W 伺服')));
  const stored = { ...design, schemaVersion: 1, kind: 'machine-design', id: design.config.id, name: design.config.name, appliedAt: '2026-01-01T00:00:00.000Z' };
  const input = JSON.parse(JSON.stringify({ ...snapshot(), machineDesign: stored, machineConfig: design.config }));
  const parsed = parseProjectSnapshot(input);
  assert.equal(parsed.machineDesign.id, stored.id);
  parsed.machineDesign.config.name = 'edited';
  assert.notEqual(input.machineDesign.config.name, 'edited');
  assert.throws(() => parseProjectSnapshot({ ...snapshot(), machineDesign: { ...stored, schemaVersion: 2 } }));
  assert.throws(() => parseProjectSnapshot({ ...snapshot(), machineDesign: { ...stored, config: {} } }));
});

test('generated conveyor assembly with horizontal cylinders survives recovery validation', () => {
  const doc = conveyorAssembly(buildConveyorParts({ lengthMm: 6000, widthMm: 1200, heightMm: 800, layers: 1, turnerAngleDeg: 90 }));
  const featureTreeJson = JSON.stringify(doc);
  assert.equal(parseProjectSnapshot({ ...snapshot(), featureTreeJson }).featureTreeJson, featureTreeJson);
});

test('snapshot requires exact complete bounded JSON and excludes runtime credentials', () => {
  for (const change of [{ schemaVersion: 2 }, { projectId: '' }, { meshSignature: 'x'.repeat(64) }, { ioPoints: undefined }, { credentials: { password: 'secret' } }, { machineConfig: { host: 'localhost' } }]) {
    assert.throws(() => parseProjectSnapshot({ ...snapshot(), ...change }));
  }
  const missing = snapshot();
  delete missing.projectId;
  assert.throws(() => parseProjectSnapshot(missing));
  assert.throws(() => parseProjectSnapshot({ ...snapshot(), sourceName: 'x'.repeat(MAX_PROJECT_SNAPSHOT_BYTES) }));
  const cyclic = snapshot(); cyclic.machineConfig = cyclic;
  assert.throws(() => parseProjectSnapshot(cyclic));
  assert.throws(() => parseProjectSnapshot({ ...snapshot(), viewState: { ...view(), fovDeg: NaN } }));
  assert.throws(() => parseProjectSnapshot({ ...snapshot(), sourceName: new Date() }));
});

test('view-state validation rejects degenerate cameras and clones coordinates', () => {
  for (const change of [{ schemaVersion: 2 }, { position: [0, 0, 0] }, { up: [0, 0, 0] }, { up: [10, 20, 30] }, { fovDeg: 180 }, { position: [1, 2] }, { wireframe: 1 }, { extra: true }]) {
    assert.throws(() => parseProjectViewState({ ...view(), ...change }));
  }
  const input = view();
  const parsed = parseProjectViewState(input);
  parsed.position[0] = 500;
  assert.equal(input.position[0], 10);
});

test('feature tree and local annotations accept supported schemas and reject hidden fields', () => {
  const featureTreeJson = JSON.stringify({ schemaVersion: 1, features: [], updatedAt: '2026-01-01' });
  const v1 = JSON.stringify({ version: 1, sourceFile: 'machine.step', parts: [] });
  const v2 = JSON.stringify({ version: 2, projectId: 'acproj-12345678-1234-4234-8234-123456789012', sourceFile: 'machine.step', parts: [] });
  for (const kinematicsJson of [v1, v2]) {
    const parsed = parseProjectSnapshot({ ...snapshot(), featureTreeJson, kinematicsJson });
    assert.equal(parsed.kinematicsJson, kinematicsJson);
  }
  for (const featureTreeJson of ['bad json', '{"schemaVersion":99}', JSON.stringify({ schemaVersion: 1, features: [], updatedAt: 'now', token: 'secret' })]) {
    assert.throws(() => parseProjectSnapshot({ ...snapshot(), featureTreeJson }));
  }
  for (const kinematicsJson of ['{}', JSON.stringify({ version: 3, sourceFile: '', parts: [] }), JSON.stringify({ version: 1, sourceFile: '', parts: [], runtime: {} })]) {
    assert.throws(() => parseProjectSnapshot({ ...snapshot(), kinematicsJson }));
  }
});

test('IO address edits validate existing PLC rules, uniqueness, bounds and no transport', () => {
  const point = { id: 'output', name: 'Valve', area: 'coil', address: 0, dataType: 'bool', writable: false };
  assert.deepEqual(parseProjectSnapshot({ ...snapshot(), ioPoints: [point] }).ioPoints, [point]);
  assert.deepEqual(parseProjectSnapshot({ ...snapshot(), ioPoints: [] }).ioPoints, []);
  for (const ioPoints of [[{ ...point, host: 'localhost' }], [{ ...point, address: -1 }], [{ ...point, dataType: 'int16' }], [point, point], [point, { ...point, id: 'other', name: 'Other' }], [point, { ...point, id: 'other', address: 1 }]]) {
    assert.throws(() => parseProjectSnapshot({ ...snapshot(), ioPoints }));
  }
});
