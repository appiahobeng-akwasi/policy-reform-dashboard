// Guards CLAUDE.md rule 8: no user-facing string outside the i18n catalogues.
// Checks the text between tags in .astro templates. Text must come from {t(...)}.
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(import.meta.dirname, '../../src');

function astroFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return astroFiles(path);
    return entry.name.endsWith('.astro') ? [path] : [];
  });
}

/** Removes frontmatter, <style>/<script> blocks, comments and {expressions}. */
function visibleTemplateText(source: string): string {
  let text = source.replace(/^---[\s\S]*?\n---/, '');
  text = text.replace(/<(style|script)\b[\s\S]*?<\/\1>/g, '');
  text = text.replace(/<!--[\s\S]*?-->/g, '');
  let out = '';
  let depth = 0;
  for (const ch of text) {
    if (ch === '{') depth += 1;
    else if (ch === '}') depth = Math.max(0, depth - 1);
    else if (depth === 0) out += ch;
  }
  // Drop tags (with their attributes); what is left is literal text content.
  return out.replace(/<[^>]*>/g, ' ');
}

function literalWords(source: string): string[] {
  return visibleTemplateText(source)
    .split(/\s+/)
    .filter((word) => /\p{L}/u.test(word));
}

describe('the check itself', () => {
  it('passes text that comes from t()', () => {
    expect(literalWords('---\nconst a = "x";\n---\n<p class="note">{t(lang, "home.intro")}</p>')).toEqual([]);
  });

  it('fails literal text between tags', () => {
    expect(literalWords('<h1>{t(lang, "home.title")}</h1>\n<p>Sign in here</p>')).toEqual(['Sign', 'in', 'here']);
  });
});

describe('templates', () => {
  const files = astroFiles(SRC);

  it('finds the templates to check', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files.map((f) => [relative(SRC, f), f]))('%s has no hard-coded text', (_name, file) => {
    expect(literalWords(readFileSync(file, 'utf8'))).toEqual([]);
  });
});
