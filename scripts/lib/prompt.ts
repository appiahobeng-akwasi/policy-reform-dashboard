// Terminal prompts for the hosted set-up commands. Secrets are read without being shown.
import { createInterface } from 'node:readline/promises';

/** Reads a line without showing it; says how many characters arrived instead. */
export function askHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    let value = '';
    // Echo off before the question appears, so nothing typed at once is shown.
    stdin.setRawMode(true);
    stdin.setEncoding('utf8');
    stdin.resume();
    process.stdout.write(question);
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\u0003') {
          stdin.setRawMode(false);
          process.stdout.write('\n');
          process.exit(130);
        } else if (ch === '\r' || ch === '\n') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off('data', onData);
          process.stdout.write(`(${value.length} characters received)\n`);
          resolve(value);
          return;
        } else if (ch === '\u007f' || ch === '\b') {
          value = value.slice(0, -1);
        } else {
          value += ch;
        }
      }
    };
    stdin.on('data', onData);
  });
}

/** Reads a visible line; Enter alone keeps the suggested value. */
export async function ask(question: string, suggested: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(`${question} [${suggested}]: `)).trim();
    return answer || suggested;
  } finally {
    rl.close();
  }
}
