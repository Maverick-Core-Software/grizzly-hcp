/**
 * Print HCP employees (pro UUIDs) so JAIME_PRO_UUID can be filled into .env.
 * Requires the housecall-pro-mcp daemon running on HCP_MCP_URL.
 * Run: npm run list-employees
 */
import 'dotenv/config';
import { listEmployees } from '../src/hcp/mcp-client.js';

const { employees } = await listEmployees();
for (const e of employees) {
  const id = e.id ?? e.uuid ?? e.pro_uuid ?? '?';
  const name =
    e.name ??
    [e.first_name, e.last_name].filter(Boolean).join(' ') ??
    '?';
  console.log(`${String(id)}  ${String(name)}  ${String(e.mobile_number ?? e.phone ?? '')}`);
}
process.exit(0);
