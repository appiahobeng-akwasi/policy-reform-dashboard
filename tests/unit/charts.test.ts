// Chart geometry (docs/08 v0.2 section 4): rings, due bars and reform themes.
import { describe, expect, it } from 'vitest';
import { area, barSteps, progressToTarget, DUE_SCALE_DAYS, dueBar, gauge, mix, PALETTE, reformTheme, ring, splitSteps } from '../../src/lib/charts';

describe('ring', () => {
  const RING_SIZES = [44, 120, 168];
  const chord = ([x1, y1]: [number, number], [x2, y2]: [number, number]) => Math.hypot(x2 - x1, y2 - y1);
  const MIX = [
    { value: 3, colour: 'coral' },
    { value: 1, colour: 'sun' },
    { value: 1, colour: 'sky' },
    { value: 2, colour: 'leaf' },
  ] as const;

  it('leaves out empty parts and keeps the order of the rest', () => {
    const r = ring(168, [
      { value: 4, colour: 'coral' },
      { value: 0, colour: 'sky' },
      { value: 1, colour: 'sun' },
    ]);
    expect(r.segments.map((s) => s.colour)).toEqual(['coral', 'sun']);
  });

  it('draws nothing when every part is empty', () => {
    expect(ring(100, [{ value: 0, colour: 'coral' }]).segments).toEqual([]);
  });

  // The fault the product owner saw: round ends reached past their part and covered the next one.
  for (const size of RING_SIZES) {
    it(`leaves the same clear gap between every pair of parts, round ends included (${size} px)`, () => {
      const r = ring(size, [...MIX]);
      const circumference = 2 * Math.PI * r.radius;
      const gaps = r.segments.map((s, i) => {
        const next = r.segments[(i + 1) % r.segments.length]!;
        return (next.span[0] - s.span[1] + circumference) % circumference;
      });
      for (const g of gaps) expect(g).toBeGreaterThan(2.9);
      expect(Math.max(...gaps) - Math.min(...gaps)).toBeLessThan(0.05);
    });
  }

  it('shows a tiny part as a round dot at least one ring-width long, not a sliver', () => {
    for (const size of RING_SIZES) {
      const r = ring(size, [
        { value: 60, colour: 'coral' },
        { value: 1, colour: 'sky' },
        { value: 1, colour: 'sun' },
      ]);
      for (const small of r.segments.slice(1)) expect(small.span[1] - small.span[0]).toBeGreaterThanOrEqual(r.width - 0.05);
    }
  });

  it('sizes parts by their share', () => {
    const r = ring(168, [
      { value: 3, colour: 'coral' },
      { value: 1, colour: 'leaf' },
    ]);
    const length = (i: number) => r.segments[i]!.span[1] - r.segments[i]!.span[0];
    expect(length(0)).toBeGreaterThan(length(1) * 2.5);
  });

  it('starts the first part just after the top and runs clockwise', () => {
    const r = ring(168, [{ value: 1, colour: 'coral' }, { value: 1, colour: 'leaf' }]);
    const [a, b] = r.segments;
    expect(a!.span[0]).toBeGreaterThan(0);
    expect(a!.span[0]).toBeLessThan(r.width);
    expect(b!.span[0]).toBeGreaterThan(a!.span[1]);
  });

  it('draws each part as one closed outline with half-circle round ends', () => {
    const r = ring(168, [...MIX]);
    for (const s of r.segments) {
      expect(s.outline.match(/Z/g)).toHaveLength(1);
      expect(s.outline.match(new RegExp(`A${r.width / 2} ${r.width / 2} 0 0 1`, 'g'))).toHaveLength(2);
      expect(s.evenOdd).toBe(false);
    }
  });

  it('shades each part evenly from light to deep, with no jump between its slices', () => {
    const r = ring(168, [{ value: 9, colour: 'coral' }, { value: 1, colour: 'leaf' }]);
    const long = r.segments[0]!;
    expect(long.wedges.length).toBeGreaterThan(6);
    expect(long.wedges[0]!.stops[0]).toBe(PALETTE.coral[0]);
    expect(long.wedges.at(-1)!.stops[1]).toBe(PALETTE.coral[1]);
    for (let i = 1; i < long.wedges.length; i++) expect(long.wedges[i]!.stops[0]).toBe(long.wedges[i - 1]!.stops[1]);
    // Slices are 30 degrees at most (chord 2r sin 15°, about 0.52 r).
    for (const w of long.wedges) expect(chord(w.from, w.to)).toBeLessThanOrEqual(r.radius * 0.52 + 0.5);
  });

  it('shades a small dot smoothly across its whole length', () => {
    const r = ring(168, [{ value: 60, colour: 'coral' }, { value: 1, colour: 'sky' }]);
    const dot = r.segments[1]!;
    expect(dot.wedges).toHaveLength(1);
    expect(dot.wedges[0]!.stops).toEqual([...PALETTE.sky]);
    // The gradient runs across the dot (round ends included), not over a hair's width.
    expect(chord(dot.wedges[0]!.from, dot.wedges[0]!.to)).toBeGreaterThan(r.width * 0.9);
  });

  it('closes a lone part into a full ring with no ends and no colour seam', () => {
    const r = ring(100, [{ value: 7, colour: 'emerald' }]);
    const only = r.segments[0]!;
    expect(only.evenOdd).toBe(true);
    expect(only.wedges).toHaveLength(12);
    expect(only.wedges[0]!.stops[0]).toBe(only.wedges.at(-1)!.stops[1]);
    expect(only.span).toEqual([0, 2 * Math.PI * r.radius]);
  });
});

describe('mix', () => {
  it('blends two colours part-way', () => {
    expect(mix('#000000', '#ffffff', 0)).toBe('#000000');
    expect(mix('#000000', '#ffffff', 1)).toBe('#ffffff');
    expect(mix('#000000', '#ff8800', 0.5)).toBe('#804400');
  });
});

describe('due bar', () => {
  it('has no bar without a due date', () => {
    expect(dueBar(0, null, false)).toBeNull();
  });

  it('fills coral by days overdue, full at 90 days or more', () => {
    expect(dueBar(45, null, true)).toEqual({ tone: 'overdue', share: 0.5 });
    expect(dueBar(DUE_SCALE_DAYS + 40, null, true)).toEqual({ tone: 'overdue', share: 1 });
  });

  it('fills emerald by days left', () => {
    expect(dueBar(0, 9, true)).toEqual({ tone: 'ahead', share: 0.1 });
    expect(dueBar(0, 400, true)).toEqual({ tone: 'ahead', share: 1 });
    expect(dueBar(0, 0, true)).toEqual({ tone: 'ahead', share: 0 });
  });
});

describe('reform theme', () => {
  it('gives each reform area its fixed colour and icon (decision 74)', () => {
    expect(reformTheme('RA1')).toEqual({ key: 'ra1', icon: 'land' });
    expect(reformTheme('RA2')).toEqual({ key: 'ra2', icon: 'coin' });
    expect(reformTheme('RA3')).toEqual({ key: 'ra3', icon: 'sprout' });
  });

  it('shows programme-wide items, and anything unknown, as programme', () => {
    expect(reformTheme(null).key).toBe('programme');
    expect(reformTheme('RA9').key).toBe('programme');
  });
});

describe('gauge', () => {
  it('fills clockwise from the top by its share, with round ends inside the share', () => {
    const g = gauge(120, 25, 100, 'emerald');
    const only = g.segments[0]!;
    expect(only.evenOdd).toBe(false);
    expect(only.span[1]).toBeCloseTo(0.25 * 2 * Math.PI * g.radius, 0);
    expect(only.outline.match(new RegExp(`A${g.width / 2} ${g.width / 2} 0 0 1`, 'g'))).toHaveLength(2);
  });

  it('is a full ring at the maximum, and nothing at zero or with no score', () => {
    expect(gauge(120, 100, 100, 'emerald').segments[0]!.evenOdd).toBe(true);
    expect(gauge(120, 130, 100, 'emerald').segments[0]!.evenOdd).toBe(true);
    expect(gauge(120, 0, 100, 'emerald').segments).toEqual([]);
    expect(gauge(120, null, 100, 'emerald').segments).toEqual([]);
  });

  it('shows a very small score as a dot, not a sliver', () => {
    const g = gauge(120, 1, 100, 'coral');
    expect(g.segments[0]!.span[1]).toBeGreaterThanOrEqual(g.width);
  });
});

describe('split bar steps', () => {
  it('add up to 100 in steps of 5', () => {
    for (const values of [[5, 1, 1], [3, 1, 2], [1, 1, 1], [40, 1, 2, 7], [6, 0, 6]]) {
      const steps = splitSteps(values);
      expect(steps.reduce((a, b) => a + b, 0), values.join()).toBe(100);
      for (const n of steps) expect(n % 5).toBe(0);
    }
  });

  it('never hides a part that is not zero, and never shows one that is', () => {
    expect(splitSteps([97, 1, 1, 1])).toEqual([85, 5, 5, 5]);
    expect(splitSteps([3, 0, 1])[1]).toBe(0);
  });

  it('is empty when every part is zero', () => {
    expect(splitSteps([0, 0])).toEqual([0, 0]);
  });
});

describe('bar list steps', () => {
  it('measures each bar against the largest, in steps of 5, at least one step when not zero', () => {
    expect(barSteps([10, 5, 1, 0])).toEqual([100, 50, 10, 0]);
    expect(barSteps([100, 1])).toEqual([100, 5]);
    expect(barSteps([0, 0])).toEqual([0, 0]);
  });
});

describe('area chart', () => {
  const box = { width: 200, height: 100, left: 20, right: 0, top: 0, bottom: 20 };

  it('places points across the width and up the scale', () => {
    const a = area([0, 50, 100], box);
    expect(a.points.map((p) => [p.x, p.y])).toEqual([
      [20, 80],
      [110, 40],
      [200, 0],
    ]);
    expect(a.line).toBe('M20 80L110 40L200 0');
    expect(a.fill).toBe('M20 80L110 40L200 0L200 80L20 80Z');
  });

  it('skips missing months and has no fill with one point', () => {
    const a = area([null, 90, null], box);
    expect(a.points).toHaveLength(1);
    expect(a.points[0]!.x).toBe(110);
    expect(a.fill).toBe('');
  });

  it('keeps values outside the scale on the chart', () => {
    expect(area([150, -10], box).points.map((p) => p.y)).toEqual([0, 80]);
  });
});

describe('progress to target', () => {
  it('measures the way from baseline to target, for targets up or down', () => {
    expect(progressToTarget(10, 30, 20)).toBe(0.5);
    expect(progressToTarget(40, 20, 30)).toBe(0.5);
    expect(progressToTarget(0, 100, 150)).toBe(1);
    expect(progressToTarget(10, 30, 5)).toBe(0);
  });

  it('shows nothing unless baseline, target and value are all known and the target differs', () => {
    expect(progressToTarget(null, 30, 20)).toBeNull();
    expect(progressToTarget(10, null, 20)).toBeNull();
    expect(progressToTarget(10, 30, null)).toBeNull();
    expect(progressToTarget(10, 10, 20)).toBeNull();
    // A baseline of "TBC" reaches here as NaN.
    expect(progressToTarget(Number.NaN, 2, 0)).toBeNull();
    expect(progressToTarget(0, Number.POSITIVE_INFINITY, 1)).toBeNull();
  });
});
