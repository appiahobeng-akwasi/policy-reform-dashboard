// Fills the {placeholders} in a rule's English and French messages.

export type MessageVars = Record<string, string | number | null | undefined>;

export function fillMessage(template: string, vars: MessageVars): string {
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = vars[name];
    return value === undefined || value === null ? match : String(value);
  });
}

/**
 * The web form shows each message next to its field, where "Row 1:" means nothing.
 * Removes the leading "Row n: " (English) or "Ligne n : " (French).
 */
export function withoutRowPrefix(message: string): string {
  const stripped = message.replace(/^(Row \d+: |Ligne \d+ : )/, '');
  return stripped.charAt(0).toUpperCase() + stripped.slice(1);
}

/**
 * A rule's message in general form, for the rules reference (decision 85): without the row it is
 * about, and with each placeholder ("{value}", {field}) shown as a bracketed word such as [value].
 */
export function generalMessage(template: string, words: Record<string, string>): string {
  const general = template
    .replace(/^(Row \{row\}: |Ligne \{row\} : )/, '')
    .replace(/"?\{(\w+)\}"?/g, (_match, name: string) => words[name] ?? '…');
  return general.charAt(0).toUpperCase() + general.slice(1);
}

/** A value as it appears in a message or a finding. */
export function shown(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}
