/**
 * 材质着色：不得只是“写了四种颜色”，必须是**肉眼分得开**的四种。
 *
 * 回归背景：旧色板 AL6063 #b9c4cc / STEEL45 #e3eaf0 的 CIE76 色差只有 13.9，
 * 截图上看就是同一种灰——用户当场指出「标色似乎没实现」。这条下限把“看起来分得开”
 * 变成可测的数字，避免以后再退回灰阶配色。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

const { MATERIAL_COLORS } = await import('../../src/machine/machine-geometry.ts');

/** sRGB → CIE Lab（D65），用于 CIE76 色差。 */
function toLab(hex) {
  const h = hex.replace('#', '');
  const v = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  const lin = v.map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  const [r, g, b] = lin;
  const X = (r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047;
  const Y = r * 0.2126 + g * 0.7152 + b * 0.0722;
  const Z = (r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883;
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const fx = f(X), fy = f(Y), fz = f(Z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

function deltaE76(a, b) {
  const la = toLab(a), lb = toLab(b);
  return Math.hypot(la[0] - lb[0], la[1] - lb[1], la[2] - lb[2]);
}

test('四种材质都有颜色，且都是合法 hex', () => {
  for (const material of ['AL6063', 'Q235', 'STEEL45', 'PVC']) {
    const color = MATERIAL_COLORS[material];
    assert.match(color ?? '', /^#[0-9a-f]{6}$/i, `${material} 缺颜色或格式不对：${color}`);
  }
});

test('任意两种材质 CIE76 色差 ≥ 55（旧灰阶配色 13.9 会直接红）', () => {
  const names = Object.keys(MATERIAL_COLORS);
  const pairs = [];
  for (let i = 0; i < names.length; i += 1) {
    for (let j = i + 1; j < names.length; j += 1) {
      const d = deltaE76(MATERIAL_COLORS[names[i]], MATERIAL_COLORS[names[j]]);
      pairs.push([names[i], names[j], d]);
      assert.ok(d >= 55, `${names[i]} vs ${names[j]} ΔE76=${d.toFixed(1)} < 55，肉眼分不出`);
    }
  }
  assert.equal(pairs.length, 6, '四种材质应有 6 对比较');
});

test('旧灰阶配色确实不合格（负向对照，证明阈值不是空设）', () => {
  const legacy = { AL6063: '#b9c4cc', Q235: '#6d7784', PVC: '#2f7d4f', STEEL45: '#e3eaf0' };
  const d = deltaE76(legacy.AL6063, legacy.STEEL45);
  assert.ok(d < 20, `旧配色 AL6063/STEEL45 应小于 20，实测 ${d.toFixed(1)}`);
});
