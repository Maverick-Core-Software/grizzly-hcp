/**
 * CLI: npm run templates
 * Lists all saved estimate templates from HCP.
 * Use the uuid values with: npm run estimate <file> --template <eot_uuid>
 */
import 'dotenv/config';
import { listTemplates } from './estimates.js';

const templates = await listTemplates();
if (!templates.length) {
  console.log('No templates found (or not logged in — run: npm run login)');
} else {
  console.log(`\nFound ${templates.length} estimate template(s):\n`);
  for (const t of templates) {
    console.log(`  ${t.uuid}  ${t.name}`);
  }
  console.log('\nUsage: npm run estimate <file> --template <eot_uuid>');
}
