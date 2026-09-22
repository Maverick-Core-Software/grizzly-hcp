/**
 * Self-check for the C0 block content contract. No test framework — run from the
 * worktree root with:
 *
 *   npx tsx src/agent/voice/blocks.check.ts
 *
 * In-repo sources only: no network, no credentials, no process started, no model
 * or tool is invoked anywhere in this file, and nothing is written. The wording
 * audit's dirty fixtures are built in memory; the shipped table is never mutated.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { C0_ENQUEUE_KINDS } from './c0-controller.js';
import {
  C0_BLOCK_KEYS,
  C0_BLOCK_REFUSAL_FIELDS,
  C0_BLOCK_RENDERED_FIELDS,
  C0_BLOCK_WORDING,
  MAX_WORDING_CHARS,
  TERMINAL_PUNCTUATION,
  auditC0Wording,
  isC0BlockKey,
  renderC0Block,
  type C0BlockRendered,
  type C0WordingAuditOptions,
  type C0WordingRule,
  type C0WordingViolation,
} from './blocks.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * The token list the wording is checked against is supplied HERE, by the caller,
 * rather than living in the module: naming these tokens in a Stage 1 source would
 * put them in a file the isolation scan requires to be free of them.
 */
const PROHIBITED_TOKENS: readonly string[] = [
  'voice-server',
  'conversationrelay',
  'twilio',
  'livekit',
  'openai',
  'housecall',
  'proxmox',
  'ct102',
  'sqlite',
  'axios',
  '@mastra',
  'node-fetch',
  'zod',
];

function withoutKey(key: string): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...C0_BLOCK_WORDING };
  delete copy[key];
  return copy;
}

function withLine(key: string, line: unknown): Record<string, unknown> {
  return { ...C0_BLOCK_WORDING, [key]: line };
}

function rulesFor(
  table: Readonly<Record<string, unknown>>,
  key: string,
  options: C0WordingAuditOptions = {},
): C0WordingRule[] {
  return auditC0Wording(table, options)
    .filter((violation: C0WordingViolation) => violation.key === key)
    .map((violation) => violation.rule);
}

function main(): void {
  const blockSrc = readFileSync(resolve(__dirname, 'blocks.ts'), 'utf-8');
  const entrySrc = readFileSync(resolve(__dirname, 'c0-entry.ts'), 'utf-8');

  // ─── 1. The inventory is closed, unique, frozen and complete ────────────
  {
    assert.equal(C0_BLOCK_KEYS.length, 8, 'eight reviewed transitions');
    assert.equal(new Set(C0_BLOCK_KEYS).size, C0_BLOCK_KEYS.length, 'no duplicate key');
    assert.deepEqual(
      (Object.keys(C0_BLOCK_WORDING) as string[]).sort(),
      [...C0_BLOCK_KEYS].sort(),
      'the table carries exactly the reviewed inventory — no more, no fewer',
    );
    assert.ok(Object.isFrozen(C0_BLOCK_KEYS), 'the key inventory cannot be extended at runtime');
    assert.ok(Object.isFrozen(C0_BLOCK_WORDING), 'the wording cannot be replaced at runtime');
    assert.throws(
      () => {
        (C0_BLOCK_WORDING as unknown as Record<string, string>).opening = 'Replaced line.';
      },
      'a frozen table refuses a write',
    );
    assert.throws(() => {
      (C0_BLOCK_KEYS as unknown as string[]).push('unreviewed');
    }, 'a frozen inventory refuses a new key');
  }

  // ─── 2. The shipped wording passes its own audit ────────────────────────
  {
    assert.deepEqual(auditC0Wording(), [], 'the shipped table audits clean');
    assert.deepEqual(
      auditC0Wording(C0_BLOCK_WORDING, { denyTokens: PROHIBITED_TOKENS }),
      [],
      'no reviewed line names a prohibited token',
    );
    assert.equal(MAX_WORDING_CHARS, 120);
    assert.equal(TERMINAL_PUNCTUATION, '.?!');
  }

  // ─── 3. Every reviewed line renders, by key alone ───────────────────────
  {
    for (const key of C0_BLOCK_KEYS) {
      const result = renderC0Block(key);
      assert.ok(result.ok, `${key} renders`);
      const rendered = result as C0BlockRendered;
      assert.deepEqual(Object.keys(rendered).sort(), [...C0_BLOCK_RENDERED_FIELDS], 'closed shape');
      assert.equal(rendered.key, key);
      assert.equal(rendered.text, C0_BLOCK_WORDING[key], 'the line is the reviewed literal');
      assert.equal(rendered.text.trim(), rendered.text, 'a reviewed line is already trimmed');
      assert.ok(rendered.text.length > 0 && rendered.text.length <= MAX_WORDING_CHARS);
      assert.ok(!/\d/.test(rendered.text), `${key} carries no digit at all`);
      assert.ok(isC0BlockKey(rendered.key));
    }

    const lines = C0_BLOCK_KEYS.map((key) => C0_BLOCK_WORDING[key]);
    assert.equal(new Set(lines).size, lines.length, 'no two transitions share a line');
  }

  // ─── 4. The renderer takes a KEY and nothing else ──────────────────────
  {
    // Arity is the structural proof: with one parameter there is nowhere to pass
    // a transcript, a caller name, a slot, a destination or a model completion.
    assert.equal(renderC0Block.length, 1, 'renderC0Block takes exactly one argument');

    const notKeys: unknown[] = [
      'transfer',
      'Opening',
      'opening ',
      ' opening',
      '',
      ' ',
      null,
      undefined,
      42,
      true,
      {},
      [],
      () => 'opening',
      new String('opening'),
      '__proto__',
      'constructor',
      'toString',
      '+15551230001',
      'opening\n',
      '2026-09-22',
    ];
    for (const value of notKeys) {
      const result = renderC0Block(value);
      assert.equal(result.ok, false, `${String(value)} is not a reviewed key`);
      assert.deepEqual(Object.keys(result).sort(), [...C0_BLOCK_REFUSAL_FIELDS], 'closed shape');
      assert.equal(
        (result as { reason: string }).reason,
        'block_not_reviewed',
        'an unknown key refuses — it never falls back to a line',
      );
      assert.equal('text' in result, false, 'a refusal carries no text at all');
    }
    assert.equal(isC0BlockKey('transfer'), false, 'a decision word is not a wording key');
    assert.equal(isC0BlockKey('opening'), true);
  }

  // ─── 5. Every rendered line is a static literal in the reviewed source ──
  {
    for (const key of C0_BLOCK_KEYS) {
      const line = C0_BLOCK_WORDING[key];
      assert.ok(
        blockSrc.includes("'" + line + "'"),
        `${key} must exist in the source as a single-quoted literal`,
      );
      assert.ok(
        !entrySrc.includes(line),
        'the entry contract must not carry any caller-facing wording',
      );
    }
  }

  // ─── 6. The audit catches every rule it claims to enforce ───────────────
  {
    const cases: ReadonlyArray<
      readonly [string, string, Readonly<Record<string, unknown>>, C0WordingRule, C0WordingAuditOptions?]
    > = [
      ['an absent reviewed key', 'opening', withoutKey('opening'), 'missing'],
      [
        'a key that was never reviewed',
        'not_reviewed',
        withLine('not_reviewed', 'Hello there.'),
        'unreviewed_key',
      ],
      ['a non-string line', 'opening', withLine('opening', 42), 'not_a_string'],
      ['an empty line', 'opening', withLine('opening', ''), 'empty'],
      ['a leading space', 'opening', withLine('opening', ' Thanks for calling.'), 'untrimmed'],
      ['a trailing space', 'opening', withLine('opening', 'Thanks for calling. '), 'untrimmed'],
      ['an over-long line', 'opening', withLine('opening', 'A' + 'b'.repeat(139) + '.'), 'too_long'],
      ['a control character', 'opening', withLine('opening', 'Hello\nthere.'), 'control_character'],
      ['a non-ASCII character', 'opening', withLine('opening', 'H\u00e9llo there.'), 'non_ascii'],
      ['a run of spaces', 'opening', withLine('opening', 'Hello  there.'), 'double_space'],
      ['lower-case opening', 'opening', withLine('opening', 'hello there.'), 'not_sentence_case'],
      ['no terminal punctuation', 'opening', withLine('opening', 'Hello there'), 'no_terminal_punctuation'],
      ['an interpolation slot', 'opening', withLine('opening', 'Hello ${name}.'), 'interpolation_marker'],
      [
        'contact detail in a line',
        'opening',
        withLine('opening', 'Call me at +1 555 123 0009.'),
        'looks_sensitive',
      ],
      [
        'a caller-supplied denied token',
        'opening',
        withLine('opening', 'Hello from the sesame desk.'),
        'denied_token',
        { denyTokens: ['sesame'] },
      ],
      [
        'a real prohibited token',
        'opening',
        withLine('opening', 'Powered by the twilio desk.'),
        'denied_token',
        { denyTokens: PROHIBITED_TOKENS },
      ],
    ];

    for (const [label, key, table, rule, options] of cases) {
      assert.deepEqual(
        rulesFor(table, key, options),
        [rule],
        `${label} must be reported as exactly ${rule}`,
      );
    }

    // The audit is pure and does not touch the frozen shipped table.
    assert.deepEqual(auditC0Wording(), [], 'the shipped table is still clean');
    assert.equal(Object.isFrozen(C0_BLOCK_WORDING), true);
  }

  // ─── 7. The inventory covers the controller's decision vocabulary ───────
  {
    for (const kind of C0_ENQUEUE_KINDS) {
      assert.ok(
        C0_BLOCK_KEYS.some((key) => key.startsWith(kind)),
        `the reviewed inventory has a transition for ${kind}`,
      );
    }
  }

  // ─── 8. §0 source invariants for the content module ─────────────────────
  {
    const specifiers = [...blockSrc.matchAll(/(?:from\s+|import\s*\(\s*)'([^']+)'/g)].map((m) => m[1]);
    assert.deepEqual(specifiers, ['./outbox.js'], 'the content module imports only a local primitive');
    assert.ok(
      !blockSrc.includes('node:'),
      'the content module references no builtin module — it cannot reach storage or a socket',
    );
    for (const probe of [
      'process.env',
      'console.',
      'Date.now',
      'async',
      'await ',
      'Promise',
      '$' + '{',
      'new Function',
      'eval(',
      'import(',
    ]) {
      assert.ok(!blockSrc.includes(probe), `blocks.ts must not contain ${probe}`);
    }

    const forbidden: ReadonlyArray<readonly [string, RegExp]> = [
      ['the production call service', /voice-server/i],
      ['the production call protocol', /conversationrelay/i],
      ['the telephony provider', /twilio/i],
      ['the realtime transport vendor', /livekit/i],
      ['a third-party model provider', /openai/i],
      ['the CRM vendor', /housecall/i],
      ['the CRM abbreviation', /\bhcp\b/i],
      ['the hypervisor host', /proxmox/i],
      ['the deploy host', /ct102/i],
      ['an embedded SQL database', /sqlite/i],
      ['a third-party HTTP/client package', /axios|@mastra|node-fetch|\bzod\b/i],
      ['a network call', /\bfetch\s*\(|node:https?|node:net|node:dns|WebSocket/i],
      ['a subprocess', /child_process|spawnSync|spawn\s*\(/i],
      ['a daemon/process shape', /setInterval|setTimeout|\.listen\s*\(|process\.exit/i],
      ['a CommonJS require', /\brequire\s*\(/],
      ['a phone-shaped literal', /\+\d{7,}/],
      ['generated code', /\beval\s*\(|new\s+Function/],
    ];
    for (const [label, pattern] of forbidden) {
      assert.ok(!pattern.test(blockSrc), `blocks.ts must not reference ${label}`);
    }
  }

  console.log('blocks.check OK');
}

main();
