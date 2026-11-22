// Deterministic screening fixtures shared by the pre-optimization hash oracle
// and the broad-phase equivalence test.
//
// These deliberately cover the regimes where a candidate filter can go wrong:
// everything far apart, everything touching within the EPS tolerance, dense
// clusters, mixed shapes/rotations, cylinders inside boxes, and parts with
// non-finite coordinates.

function box(id, center, size, rotationZDeg = 0) {
  return { id, name: id, role: 'structure', shape: { type: 'box', size }, center, rotationZDeg };
}

function cylinder(id, center, radius, length, axis = 'z') {
  return { id, name: id, role: 'actuator', shape: { type: 'cylinder', radius, length, axis }, center, rotationZDeg: 0 };
}

function grid(count, spacing, seed = 7) {
  let state = seed >>> 0;
  const random = () => { state = (1664525 * state + 1013904223) >>> 0; return state / 4294967296; };
  return {
    parts: Array.from({ length: count }, (_, index) =>
      box(`st${index % 9}-g${index}`, [(index % 15) * spacing, Math.floor(index / 15) * spacing, 0], [
        20 + random() * 30, 20 + random() * 30, 20 + random() * 30
      ]))
  };
}

export const screenFixtures = {
  /** 200 boxes on a 400 mm grid: almost every pair is irrelevant. */
  farApart: grid(200, 400),
  /** Same grid but 20.4 mm pitch: heavy proximity, exercises the epsilon boundary. */
  nearTouch: {
    parts: Array.from({ length: 120 }, (_, index) =>
      box(`st${index % 6}-n${index}`, [(index % 12) * 20.4, Math.floor(index / 12) * 20.4, 0], [20, 20, 20]))
  },
  /** 1000 boxes on a 400 mm grid: the sparse regime the filter targets. */
  farApartLarge: grid(1000, 400),
  /** Everything overlapping: the filter must not drop anything here. */
  denseCluster: {
    parts: Array.from({ length: 60 }, (_, index) =>
      box(`st${index % 4}-c${index}`, [index * 0.7, index * 0.3, index * 0.2], [40, 40, 40], index % 3))
  },
  /** Mixed primitives, rotations, and a cylinder fully inside a box. */
  mixed: {
    parts: [
      box('st1-plate', [0, 0, 0], [400, 300, 20]),
      box('st1-upright-l', [-180, 0, 200], [60, 60, 400]),
      box('st1-upright-r', [180, 0, 200], [60, 60, 400]),
      box('st1-beam', [0, 0, 400], [400, 40, 40]),
      cylinder('st1-clamp-body', [0, 0, 120], 16, 100),
      cylinder('st1-clamp-rod', [0, 0, 160], 6, 90),
      box('sensor-st1-a-bracket', [60, 120, 30], [20, 20, 40]),
      cylinder('sensor-st1-a', [60, 120, 34], 4, 30, 'y'),
      box('frame-leg-1', [-500, 0, 0], [60, 60, 800]),
      box('frame-stringer-front', [-500, 0, 400], [400, 40, 40]),
      box('tilted', [260, 60, 60], [80, 30, 30], 37),
      cylinder('side-axis', [300, -80, 90], 10, 60, 'x')
    ]
  },
  /** Non-finite coordinates must keep the old behaviour rather than vanish. */
  withNaN: {
    parts: [
      box('a', [0, 0, 0], [100, 100, 100]),
      box('b', [50, 0, 0], [100, 100, 100]),
      { id: 'bad', name: 'bad', role: 'structure', shape: { type: 'box', size: [10, 10, 10] }, center: [Number.NaN, 0, 0], rotationZDeg: 0 }
    ]
  }
};
