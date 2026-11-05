// Auto-fixes X01 and X02: small clean-ups made for the user, logged as "fixed", never costing score.
import { text, type AutoFix, type Fix } from './common';

function trimmed(value: unknown): unknown {
  return typeof value === 'string' ? value.trim() : value;
}

/** "In Progress", "in-progress" and "IN_PROGRESS" all read as in_progress. */
function normalised(value: string): string {
  return value.trim().toLowerCase().replace(/[\s-]+/g, '_');
}

export const AUTOFIX: Record<string, AutoFix> = {
  X01(row) {
    const fixes: Fix[] = [];
    const codeFields = [row.spec.idField, ...Object.keys(row.spec.references), ...Object.keys(row.spec.controlled), 'source_id'];
    if (typeof row.row.id === 'string' && row.row.id !== row.row.id.trim()) {
      fixes.push({ field: row.spec.idField, from: row.row.id, to: row.row.id.trim() });
    }
    for (const field of codeFields) {
      const value = row.fields[field];
      if (typeof value === 'string' && value !== value.trim()) fixes.push({ field, from: value, to: value.trim() });
    }
    for (const listField of ['evidence_ids', 'depends_on'] as const) {
      const list = row.row[listField];
      if (list?.some((item) => item !== trimmed(item))) fixes.push({ field: listField, from: list, to: list.map((item) => item.trim()) });
    }
    if (row.row.links?.some((link) => link.object_id !== link.object_id.trim() || link.object_type !== link.object_type.trim())) {
      fixes.push({
        field: 'links',
        from: row.row.links,
        to: row.row.links.map((link) => ({ object_type: link.object_type.trim(), object_id: link.object_id.trim() })),
      });
    }
    return fixes;
  },

  X02(row, env) {
    const fixes: Fix[] = [];
    for (const [field, listName] of Object.entries(row.spec.controlled)) {
      const value = text(row.fields[field]);
      const list = env.context.lists[listName];
      if (value === null || list === undefined || list.includes(value)) continue;
      const canonical = list.find((code) => normalised(code) === normalised(value));
      if (canonical !== undefined) fixes.push({ field, from: value, to: canonical });
    }
    return fixes;
  },
};
