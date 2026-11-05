// Writes the sign-in email template from the i18n catalogues. Run after changing email.* strings,
// then restart Supabase (supabase stop && supabase start) so it reads the new template.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { signInEmailHtml, SIGN_IN_TEMPLATE_PATH } from '../src/lib/email/sign-in-template';
import { ROOT } from './lib/db';

writeFileSync(join(ROOT, SIGN_IN_TEMPLATE_PATH), signInEmailHtml());
console.log(`Wrote ${SIGN_IN_TEMPLATE_PATH}`);
