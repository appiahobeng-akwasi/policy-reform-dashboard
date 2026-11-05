// Geometry for the hand-drawn SVG charts (docs/08 v0.2 section 4). Pure functions, so the
// components stay thin and the maths is unit tested. No chart library (CLAUDE.md rule 9).

/** Chart gradients, light to deep. The same pairs as the --gradient-* tokens in tokens.css. */
export const PALETTE = {
  coral: ['#ff9b7a', '#e0453a'],
  sun: ['#ffd66e', '#f0971c'],
  leaf: ['#c2ec74', '#4fb548'],
  sky: ['#8db8ff', '#3a68dc'],
  emerald: ['#4fe0ad', '#008a63'],
} as const;
export type ChartColour = keyof typeof PALETTE;

export type RingPart = { value: number; colour: ChartColour };
/** A slice of colour inside a part's outline, with its own two-stop gradient. */
export type RingWedge = { d: string; from: [number, number]; to: [number, number]; stops: [string, string] };
export type RingSegment = {
  colour: ChartColour;
  /** The part's shape: the arc with its two round ends, as one closed outline (one clean edge). */
  outline: string;
  /** The outline is a full annulus (a lone part), drawn with the even-odd rule. */
  evenOdd: boolean;
  /** Overlapping slices clipped to the outline, shading evenly from light to deep. */
  wedges: RingWedge[];
  /** Where the part starts and ends along the ring's middle line, round ends included (pixels from the top). */
  span: [number, number];
};
export type Ring = { centre: number; radius: number; width: number; segments: RingSegment[] };

const round = (n: number) => Math.round(n * 100) / 100;

/** A colour part-way between two hex colours (t from 0 to 1). */
export function mix(from: string, to: string, t: number): string {
  const channel = (hex: string, i: number) => Number.parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16);
  return `#${[0, 1, 2]
    .map((i) => Math.round(channel(from, i) + (channel(to, i) - channel(from, i)) * t))
    .map((v) => v.toString(16).padStart(2, '0'))
    .join('')}`;
}

/**
 * How much of the ring each part gets. A part too small to see is shown as a round dot (one
 * ring-width plus its gaps); the space comes from the parts that can spare it, in proportion.
 * The exact numbers are always printed beside the ring, so this only helps the eye.
 */
function displayShares(values: number[], circumference: number, minimum: number): number[] {
  const total = values.reduce((sum, v) => sum + v, 0);
  const exact = values.map((v) => (v / total) * circumference);
  if (minimum * values.length >= circumference) return exact;
  const small = exact.map((share) => share < minimum);
  const needed = exact.reduce((sum, share, i) => sum + (small[i] ? minimum - share : 0), 0);
  const spare = exact.reduce((sum, share, i) => sum + (small[i] ? 0 : share - minimum), 0);
  if (needed === 0 || spare <= 0) return exact;
  return exact.map((share, i) => (small[i] ? minimum : share - ((share - minimum) / spare) * needed));
}

/** The drawing frame of a ring: its sizes and the helpers that turn angles into SVG paths. */
function frame(size: number, widthShare: number) {
  const width = round(size * widthShare);
  const half = width / 2;
  const centre = size / 2;
  const radius = round(centre - half - 2);
  const outer = radius + half;
  const inner = radius - half;
  const circumference = 2 * Math.PI * radius;
  const at = (r: number, angle: number): string => `${round(centre + r * Math.sin(angle))} ${round(centre - r * Math.cos(angle))}`;
  const xy = (r: number, angle: number): [number, number] => [round(centre + r * Math.sin(angle)), round(centre - r * Math.cos(angle))];
  return { width, half, centre, radius, outer, inner, circumference, at, xy };
}
type Frame = ReturnType<typeof frame>;

/**
 * One part of a ring, as a closed outline shaded by overlapping slices. `start` and `end` are
 * where its round ends' centres sit along the middle line; `full` draws the whole annulus.
 */
function segment(f: Frame, colour: ChartColour, start: number, end: number, full: boolean): Omit<RingSegment, 'span'> {
  const { half, centre, radius, outer, inner, at, xy } = f;
  const [light, deep] = PALETTE[colour];
  const maxWedge = Math.PI / 6;
  // A slice from the centre out past the ring, from one angle to another.
  const wedge = (from: number, to: number) => `M${centre} ${centre}L${at(outer + 1, from)}A${outer + 1} ${outer + 1} 0 ${to - from > Math.PI ? 1 : 0} 1 ${at(outer + 1, to)}Z`;
  let outline: string;
  let first: number;
  let last: number;
  if (full) {
    outline = `M${at(outer, 0)}A${outer} ${outer} 0 1 1 ${at(outer, Math.PI)}A${outer} ${outer} 0 1 1 ${at(outer, 0)}ZM${at(inner, 0)}A${inner} ${inner} 0 1 0 ${at(inner, Math.PI)}A${inner} ${inner} 0 1 0 ${at(inner, 0)}Z`;
    first = 0;
    last = 2 * Math.PI;
  } else {
    const a0 = start / radius;
    const a1 = Math.max(end, start + 0.01) / radius;
    const large = a1 - a0 > Math.PI ? 1 : 0;
    outline = `M${at(outer, a0)}A${outer} ${outer} 0 ${large} 1 ${at(outer, a1)}A${half} ${half} 0 0 1 ${at(inner, a1)}A${inner} ${inner} 0 ${large} 0 ${at(inner, a0)}A${half} ${half} 0 0 1 ${at(outer, a0)}Z`;
    // The round ends reach a little past their centres; the slices cover them too.
    const reach = Math.asin(Math.min(half / radius, 1)) + 0.02;
    first = a0 - reach;
    last = a1 + reach;
  }
  const count = Math.max(1, Math.ceil((last - first) / maxWedge - 1e-9));
  // A full ring closes on itself: it shades light to deep and back, so no seam shows at the top.
  const shade = (k: number) => (full ? 1 - Math.abs(1 - (2 * k) / count) : k / count);
  const wedges: RingWedge[] = [];
  for (let i = 0; i < count; i++) {
    const from = first + ((last - first) * i) / count;
    const to = first + ((last - first) * (i + 1)) / count;
    // Each slice runs a little into the next, which is drawn over it, so no seam shows.
    const overlap = i < count - 1 ? 0.02 : 0;
    wedges.push({ d: wedge(from, to + overlap), from: xy(radius, from), to: xy(radius, to), stops: [mix(light, deep, shade(i)), mix(light, deep, shade(i + 1))] });
  }
  return { colour, outline, evenOdd: full, wedges };
}

/**
 * A ring of `size` pixels split into parts, drawn clockwise from the top. Empty parts are left
 * out. Each part is one closed outline (its arc and round ends), so its edge is smooth and the
 * gaps between parts are all the same. Inside, overlapping slices shade it from the light to the
 * deep end of its gradient, along the whole part, so long parts and small dots both shade evenly
 * and no seam shows.
 */
export function ring(size: number, parts: readonly RingPart[], widthShare = 0.15): Ring {
  const f = frame(size, widthShare);
  const { width, half, centre, radius, circumference } = f;
  const shown = parts.filter((p) => p.value > 0);
  const lone = shown.length === 1;
  // The clear space between two parts, measured along the middle of the ring.
  const gap = lone ? 0 : Math.max(width * 0.35, 3);
  const shares = displayShares(
    shown.map((p) => p.value),
    circumference,
    width + gap,
  );
  let along = 0;
  const segments = shown.map((p, index) => {
    const share = shares[index]!;
    // The arc runs between the centres of its two round ends, inside its own share.
    const drawn = segment(f, p.colour, along + gap / 2 + half, along + share - gap / 2 - half, lone);
    const span: [number, number] = lone ? [0, circumference] : [round(along + gap / 2), round(along + share - gap / 2)];
    along += share;
    return { ...drawn, span };
  });
  return { centre, radius, width, segments };
}

/**
 * A gauge: one score out of `max` as an arc that fills clockwise from the top, over a track. The
 * round ends stay inside the filled share; at the maximum it is a full ring. Nothing is drawn for
 * zero, or when there is no score.
 */
export function gauge(size: number, value: number | null, max: number, colour: ChartColour, widthShare = 0.14): Ring {
  const f = frame(size, widthShare);
  const { width, half, centre, radius, circumference } = f;
  const share = value === null || max <= 0 ? 0 : Math.min(Math.max(value / max, 0), 1);
  if (share === 0) return { centre, radius, width, segments: [] };
  const full = share >= 0.999;
  const length = share * circumference;
  const drawn = segment(f, colour, half, Math.max(length - half, half), full);
  return { centre, radius, width, segments: [{ ...drawn, span: [0, round(full ? circumference : Math.max(length, width))] }] };
}

/**
 * Widths for the parts of a split bar, in the 5% steps the content policy allows (no inline
 * styles): they add up to 100, and a part that is not zero gets at least one step.
 */
export function splitSteps(values: readonly number[]): number[] {
  const total = values.reduce((sum, v) => sum + Math.max(v, 0), 0);
  if (total === 0) return values.map(() => 0);
  const exact = values.map((v) => (Math.max(v, 0) / total) * 20);
  const steps = exact.map((e, i) => (values[i]! > 0 ? Math.max(1, Math.floor(e)) : 0));
  // Give the remaining steps to the largest remainders; take any excess from the largest parts.
  let left = 20 - steps.reduce((a, b) => a + b, 0);
  const byRemainder = exact.map((e, i) => ({ i, r: e - Math.floor(e) })).sort((a, b) => b.r - a.r);
  for (let k = 0; left > 0; k = (k + 1) % byRemainder.length) {
    const i = byRemainder[k]!.i;
    if (values[i]! > 0) {
      steps[i]! += 1;
      left -= 1;
    }
  }
  while (left < 0) {
    const i = steps.indexOf(Math.max(...steps));
    steps[i]! -= 1;
    left += 1;
  }
  return steps.map((n) => n * 5);
}

/** Bar lengths against the largest value, in 5% steps; a value that is not zero shows at least one step. */
export function barSteps(values: readonly number[]): number[] {
  const max = Math.max(0, ...values);
  if (max === 0) return values.map(() => 0);
  return values.map((v) => (v > 0 ? Math.max(5, Math.round((v / max) * 20) * 5) : 0));
}

export type AreaPoint = { x: number; y: number; value: number };
/**
 * A trend for an area chart: points along the width, the line through them and the shape under
 * it. Missing values (null) are skipped; the scale runs from `min` to `max`.
 */
export function area(
  values: readonly (number | null)[],
  box: { width: number; height: number; left: number; right: number; top: number; bottom: number },
  min = 0,
  max = 100,
): { points: AreaPoint[]; line: string; fill: string; xAt: (i: number) => number; yAt: (v: number) => number } {
  const span = max - min || 1;
  const innerW = box.width - box.left - box.right;
  const innerH = box.height - box.top - box.bottom;
  const xAt = (i: number) => round(box.left + (values.length <= 1 ? innerW / 2 : (i * innerW) / (values.length - 1)));
  const yAt = (v: number) => round(box.top + ((max - Math.min(Math.max(v, min), max)) * innerH) / span);
  const points = values.flatMap((v, i) => (v === null ? [] : [{ x: xAt(i), y: yAt(v), value: v }]));
  const line = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x} ${p.y}`).join('');
  const base = yAt(min);
  const fill = points.length > 1 ? `${line}L${points.at(-1)!.x} ${base}L${points[0]!.x} ${base}Z` : '';
  return { points, line, fill, xAt, yAt };
}

/** A due bar's scale: a full bar is this many days or more (docs/08 section 4). */
export const DUE_SCALE_DAYS = 90;

/**
 * How much of the due bar to fill. Overdue items fill coral by days overdue; items still to
 * come fill emerald by days left. No due date, no bar.
 */
export function dueBar(daysOverdue: number, daysToDue: number | null, hasDueDate: boolean): { tone: 'overdue' | 'ahead'; share: number } | null {
  if (!hasDueDate) return null;
  if (daysOverdue > 0) return { tone: 'overdue', share: Math.min(daysOverdue, DUE_SCALE_DAYS) / DUE_SCALE_DAYS };
  const left = Math.max(daysToDue ?? 0, 0);
  return { tone: 'ahead', share: Math.min(left, DUE_SCALE_DAYS) / DUE_SCALE_DAYS };
}

/** The fixed colour and icon of a reform area (decision 74); anything else is programme-wide. */
export function reformTheme(reformId: string | null): { key: 'ra1' | 'ra2' | 'ra3' | 'programme'; icon: 'land' | 'coin' | 'sprout' | 'globe' } {
  switch (reformId) {
    case 'RA1':
      return { key: 'ra1', icon: 'land' };
    case 'RA2':
      return { key: 'ra2', icon: 'coin' };
    case 'RA3':
      return { key: 'ra3', icon: 'sprout' };
    default:
      return { key: 'programme', icon: 'globe' };
  }
}

/**
 * How far an indicator has moved from its baseline towards its target, from 0 to 1 (decision
 * 87). Only when baseline, target and latest value are all numbers and the target differs from
 * the baseline; works for targets that go down as well as up. Beyond the target counts as 1.
 */
export function progressToTarget(baseline: number | null, target: number | null, latest: number | null): number | null {
  // "TBC", "N/A" and other text are not numbers: no progress, rather than a wrong one.
  if (![baseline, target, latest].every((v) => typeof v === 'number' && Number.isFinite(v)) || target === baseline) return null;
  const share = (latest! - baseline!) / (target! - baseline!);
  return Math.min(Math.max(share, 0), 1);
}
