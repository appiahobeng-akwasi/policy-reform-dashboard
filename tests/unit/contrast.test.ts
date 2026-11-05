// Accessibility (CLAUDE.md, docs/08 section 6): text colours meet 4.5:1 against what they sit on,
// including both ends of every gradient that text sits on (decision 75).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(join(import.meta.dirname, '../../src/styles/tokens.css'), 'utf8');
const token = (name: string): string => {
  const value = new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, 'i').exec(css)?.[1];
  if (!value) throw new Error(`No colour token --${name}`);
  return value;
};
/** The two colour stops of a --gradient-* token. */
const stops = (name: string): string[] => {
  const value = new RegExp(`--${name}:\\s*linear-gradient\\(([^;]+)\\);`, 'i').exec(css)?.[1];
  const hexes = value?.match(/#[0-9a-f]{6}/gi) ?? [];
  if (hexes.length !== 2) throw new Error(`No two-stop gradient --${name}`);
  return hexes;
};
const luminance = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
};
const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
};
const ratio = (a: string, b: string) => contrast(token(a), token(b));

describe('colour contrast of text (at least 4.5:1)', () => {
  const PAIRS: [string, string][] = [
    ['color-text', 'color-bg'],
    ['color-text', 'color-canvas'],
    ['color-text', 'color-surface-hover'],
    ['color-text-muted', 'color-bg'],
    ['color-text-muted', 'color-canvas'],
    ['color-link', 'color-bg'],
    ['color-accent', 'color-accent-soft'],
    ['color-primary-contrast', 'color-primary'],
    ['color-primary-contrast', 'color-danger'],
    ['color-rag-green', 'color-rag-green-bg'],
    ['color-rag-amber', 'color-rag-amber-bg'],
    ['color-rag-red', 'color-rag-red-bg'],
    ['color-rag-grey', 'color-rag-grey-bg'],
    ['color-rag-blue', 'color-rag-blue-bg'],
    ['color-rag-red', 'color-bg'],
    ['color-rag-amber', 'color-bg'],
    ['color-forest-text', 'color-forest'],
    ['color-ra1', 'color-bg'],
    ['color-ra2', 'color-bg'],
    ['color-ra3', 'color-bg'],
    ['color-programme', 'color-bg'],
    ['color-text', 'color-heat-high-a'],
    ['color-text', 'color-heat-high-b'],
    ['color-text', 'color-heat-medium-a'],
    ['color-text', 'color-heat-medium-b'],
    ['color-text', 'color-heat-low-a'],
    ['color-text', 'color-heat-low-b'],
    ['color-ra1', 'color-canvas'],
    ['color-ra2', 'color-canvas'],
    ['color-ra3', 'color-canvas'],
  ];
  for (const [text, background] of PAIRS) {
    it(`${text} on ${background}`, () => {
      expect(ratio(text, background)).toBeGreaterThanOrEqual(4.5);
    });
  }

  // Text on a gradient: checked against both ends, since the weaker end decides.
  const ON_GRADIENT: [string, string][] = [
    ['color-primary-contrast', 'gradient-primary'],
    ['color-primary-contrast', 'gradient-danger'],
    ['color-primary-contrast', 'gradient-forest'],
    ['color-forest-text', 'gradient-forest'],
    ['color-text', 'gradient-canvas'],
    ['color-text-muted', 'gradient-canvas'],
    ['color-text-muted', 'gradient-card'],
    ['color-text', 'gradient-accent-soft'],
    ['color-accent', 'gradient-accent-soft'],
    ['color-rag-green', 'gradient-green-soft'],
    ['color-rag-amber', 'gradient-amber-soft'],
    ['color-rag-red', 'gradient-red-soft'],
    ['color-rag-grey', 'gradient-grey-soft'],
    ['color-rag-blue', 'gradient-blue-soft'],
  ];
  for (const [text, gradient] of ON_GRADIENT) {
    it(`${text} on both ends of ${gradient}`, () => {
      for (const end of stops(gradient)) expect(contrast(token(text), end)).toBeGreaterThanOrEqual(4.5);
    });
  }

  // Reform icons are graphics: 3:1 against both ends of their chip (WCAG 1.4.11).
  for (const key of ['ra1', 'ra2', 'ra3', 'programme']) {
    it(`the ${key} icon on both ends of its chip (3:1)`, () => {
      for (const end of stops(`gradient-${key}-soft`)) expect(contrast(token(`color-${key}`), end)).toBeGreaterThanOrEqual(3);
    });
  }

  it('the faint grey is too light for text, so it is kept for placeholders only', () => {
    expect(ratio('color-text-faint', 'color-bg')).toBeLessThan(4.5);
    const global = readFileSync(join(import.meta.dirname, '../../src/styles/global.css'), 'utf8');
    const uses = [...global.matchAll(/([^{}]+)\{[^}]*--color-text-faint[^}]*\}/g)].map((m) => m[1]!.trim());
    expect(uses.every((selector) => selector.includes('placeholder'))).toBe(true);
  });
});
