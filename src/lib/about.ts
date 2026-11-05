// The open-source notice (decision 97): the dashboard is published under the MIT licence, and
// every page says so and links to the About page with the licence, source code and version.
import pkg from '../../package.json';

export const COPYRIGHT_YEAR = 2026;

export const APP_VERSION: string = pkg.version;

/** The MIT licence as published with the source code. Legal text: shown in English only. */
export function mitLicence(holder: string): string {
  return `MIT License

Copyright (c) ${COPYRIGHT_YEAR} ${holder}

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;
}

/** The licence as paragraphs (its line breaks are only for plain-text files), for the About page. */
export function licenceParagraphs(holder: string): string[] {
  return mitLicence(holder)
    .trim()
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s*\n\s*/g, ' '));
}

/** The main open-source parts the dashboard is built on, with their licences. */
export const CREDITS: { name: string; licence: string; url: string }[] = [
  { name: 'Astro', licence: 'MIT', url: 'https://astro.build' },
  { name: 'React', licence: 'MIT', url: 'https://react.dev' },
  { name: 'PostgreSQL', licence: 'PostgreSQL Licence', url: 'https://www.postgresql.org' },
  { name: 'Supabase', licence: 'MIT / Apache-2.0', url: 'https://supabase.com' },
  { name: 'node-postgres', licence: 'MIT', url: 'https://node-postgres.com' },
  { name: 'SheetJS', licence: 'Apache-2.0', url: 'https://sheetjs.com' },
  { name: 'tus', licence: 'MIT', url: 'https://tus.io' },
  { name: 'Nodemailer', licence: 'MIT-0', url: 'https://nodemailer.com' },
  { name: 'AWS SDK for JavaScript', licence: 'Apache-2.0', url: 'https://github.com/aws/aws-sdk-js-v3' },
];
