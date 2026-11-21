import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadFactoryStationView } from '../../src/factory/station-view.ts';

for (const kind of ['flat', 'tree']) {
  test(`${kind} browse renders points and reads/subscribes to the same IDs`, async () => {
    const tag = { id: 'P1', name: 'Motor', kind: 'tag', writable: true, station: 'line/motor' };
    const station = { id: 'line', name: 'Line', kind: 'station', children: [tag] };
    const current = { id: tag.id, value: true, quality: 'good', timestamp: '2026-01-01T00:00:00Z' };
    const calls = [];
    await loadFactoryStationView({
      browse: async () => ({ ok: true, data: kind === 'flat' ? [tag] : [station] }),
      readTags: async (ids) => { calls.push(['read', ids]); return { ok: true, data: { P1: current } }; },
      subscribe: async (ids) => { calls.push(['subscribe', ids]); return { ok: true }; }
    }, {
      renderStations: (stations) => {
        assert.equal(stations.length, 1);
        assert.deepEqual(stations[0].children, [tag]);
        if (kind === 'tree') assert.equal(stations[0].id, station.id);
        calls.push(['render', stations[0].children.map(({ id }) => id)]);
      },
      updateTagValue: (value) => calls.push(['value', value]),
      showError: assert.fail
    });
    assert.deepEqual(calls, [['render', ['P1']], ['read', ['P1']], ['value', current], ['subscribe', ['P1']]]);
  });
}

test('empty or failed browse never reads or subscribes', async () => {
  for (const result of [{ ok: true, data: [] }, { ok: false, message: 'browse failed' }]) {
    const calls = [];
    await loadFactoryStationView({ browse: async () => result, readTags: assert.fail, subscribe: assert.fail }, {
      renderStations: (stations) => calls.push(['render', stations]),
      updateTagValue: assert.fail,
      showError: (message) => calls.push(['error', message])
    });
    assert.deepEqual(calls, result.ok ? [['render', []]] : [['error', 'browse failed']]);
  }
});