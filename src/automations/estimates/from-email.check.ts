/**
 * Self-check for from-email.ts service-item source selection.
 * Run: npx tsx src/automations/estimates/from-email.check.ts
 *
 * Guards the regression where the RAG-generated `scope` was thrown away and items
 * were extracted from the raw email `body` instead.
 */
import assert from 'node:assert';
import { pickExtractionSource } from './from-email.js';

const scope = 'RAG scope: 1) Replace GFCI 2) Add switch 3) 200A panel upgrade ...';
const body = 'hey can you look at my place, some stuff is broken';

// Scope is preferred when both are present.
assert.strictEqual(pickExtractionSource(scope, body), scope, 'scope must win over body');

// Falls back to body when scope is missing/empty/whitespace.
assert.strictEqual(pickExtractionSource(undefined, body), body, 'undefined scope → body');
assert.strictEqual(pickExtractionSource('', body), body, 'empty scope → body');
assert.strictEqual(pickExtractionSource('   \n  ', body), body, 'whitespace scope → body');

console.log('from-email source-selection check passed ✓');
