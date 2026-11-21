import type { Placement } from '../enclosure/layout.ts';

const GEOMETRY_KEYS = ['x', 'y', 'w', 'h'] as const;
type GeometryKey = typeof GEOMETRY_KEYS[number];

/** Validate cable geometry. The Agent may supply points without dimensions; the engine also accepts those normalized points. */
export function parseCostPlacements(value: unknown, mode: 'rectangle' | 'point' | 'normalized' = 'rectangle'): Placement[] {
  if (!Array.isArray(value)) throw new Error('placements 必须是数组');
  return Array.from(value, (item: unknown, index) => {
    const path = `placements[${index}]`;
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error(`${path} 必须是对象`);
    const raw = item as Record<string, unknown>;
    if (raw.x == null || raw.y == null) throw new Error(`缺少必填参数：${path}.x/y`);
    const number = (key: GeometryKey): number => {
      const coordinate = key === 'x' || key === 'y';
      const member = raw[key];
      if (!coordinate && mode === 'point' && member == null) return 0;
      if (typeof member !== 'number' || !Number.isFinite(member) || (!coordinate && (mode === 'rectangle' ? member <= 0 : member < 0))) {
        const range = mode === 'rectangle' ? '正的' : '非负';
        throw new Error(`${path}.${key} 必须是${coordinate ? '' : range}有限数`);
      }
      return member;
    };
    const text = (key: string, fallback: string): string => {
      const member = raw[key];
      return typeof member === 'string' ? member.trim() || fallback : fallback;
    };
    return {
      id: text('id', `p${index + 1}`), partId: text('partId', ''), model: text('model', ''),
      x: number('x'), y: number('y'), w: number('w'), h: number('h')
    };
  });
}
