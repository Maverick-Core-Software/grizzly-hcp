/**
 * Self-check for the C0 feature / configuration contract. No test framework —
 * run from the worktree root with:
 *
 *   npx tsx src/agent/voice/c0-config.check.ts
 *
 * Everything below runs with fixture string maps and in-repo sources only: no
 * network, no credentials, no process started, no file written. The allow-list
 * and caller fixtures use the reserved fictional range (555-01xx) — no real
 * phone number appears in this file.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, isAbsolute, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  C0_ENV_NAMES,
  DEFAULT_OUTBOX_MONITOR_INTERVAL_MS,
  DEFAULT_OUTBOX_PATH,
  DEFAULT_OUTBOX_STALE_MS,
  VOICE_C0_ENABLED_DEFAULT,
  evaluateC0Gate,
  isC0Enabled,
  loadC0Config,
  normalizeCallerE164,
  parseAllowlist,
  redactedConfig,
  resolveOutboxPath,
} from './c0-config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..', '..', '..'); // src/agent/voice → repo root

const FICTION_A = '+15551230001';
const FICTION_B = '+15551230002';
const FICTION_C = '+15551230003';

function main(): void {
  // ─── 1. Disabled by default ───────────────────────────────────────────────
  {
    assert.equal(VOICE_C0_ENABLED_DEFAULT, false, 'the documented default is false');

    const config = loadC0Config({});
    assert.equal(config.enabled, false, 'absent VOICE_C0_ENABLED ⇒ disabled');
    assert.deepEqual([...config.allowlist], [], 'absent allow-list ⇒ empty');
    assert.equal(config.provider, null, 'no provider is assumed');
    assert.equal(config.model, null, 'no model is assumed');
    assert.equal(config.outboxPath, DEFAULT_OUTBOX_PATH);
    assert.equal(config.staleAfterMs, DEFAULT_OUTBOX_STALE_MS);
    assert.equal(config.monitorIntervalMs, DEFAULT_OUTBOX_MONITOR_INTERVAL_MS);
    assert.deepEqual([...config.warnings], [], 'a clean default env produces no warnings');

    // The live environment, with the flag explicitly removed, is still off.
    const live: Record<string, string | undefined> = { ...process.env };
    delete live.VOICE_C0_ENABLED;
    assert.equal(loadC0Config(live).enabled, false, 'the real env without the flag ⇒ disabled');

    // Naming a provider/model configures nothing on its own.
    const named = loadC0Config({ VOICE_C0_PROVIDER: 'c0-stub', VOICE_C0_MODEL: 'stub-1' });
    assert.equal(named.provider, 'c0-stub');
    assert.equal(named.model, 'stub-1');
    assert.equal(named.enabled, false, 'naming a provider does not open gate 1');
  }

  // ─── 2. Gate 1 truth table — only the literal string 'true' enables ────────
  {
    assert.equal(isC0Enabled({ VOICE_C0_ENABLED: 'true' }), true);
    for (const value of [undefined, '', 'false', 'FALSE', 'True', '1', 'yes', 'on', ' true']) {
      assert.equal(
        isC0Enabled({ VOICE_C0_ENABLED: value }),
        false,
        `${JSON.stringify(value)} must not enable C0`,
      );
    }
  }

  // ─── 3. Allow-list parsing is fail-closed and never leaks digits ──────────
  {
    const warnings: string[] = [];
    const list = parseAllowlist(
      ` ${FICTION_A} ,${FICTION_B} ,${FICTION_A} ,5551230004 ,not-a-number, ${FICTION_C} `,
      warnings,
    );
    assert.deepEqual(list, [FICTION_A, FICTION_B, FICTION_C], 'valid entries deduped and sorted');
    assert.equal(warnings.length, 2, 'each malformed entry is reported once');

    const joined = warnings.join(' | ');
    assert.ok(!joined.includes('5551230004'), 'the warning must not leak the raw entry');
    assert.ok(!joined.includes('not-a-number'), 'the warning must not echo the raw entry');
    assert.ok(!/\d{10,}/.test(joined), 'no long digit run may appear in a config warning');

    // A caller number is never "repaired": E.164 only, no implicit country code.
    assert.equal(normalizeCallerE164('5551230001'), null, 'a bare 10-digit number is not E.164');
    assert.equal(normalizeCallerE164('+1555'), null, 'an out-of-range E.164 is refused');
    assert.equal(normalizeCallerE164('+1 (555) 123-0001'), FICTION_A, 'formatting is tolerated');
    assert.deepEqual(parseAllowlist(undefined), [], 'absent allow-list ⇒ empty');
    assert.deepEqual(parseAllowlist('   '), [], 'blank allow-list ⇒ empty');
  }

  // ─── 4. Gate matrix — both gates must be open ─────────────────────────────
  {
    const off = loadC0Config({ VOICE_C0_ENABLED: 'false', VOICE_C0_ALLOWLIST: FICTION_A });
    assert.deepEqual(
      evaluateC0Gate(off, FICTION_A),
      { allowed: false, reason: 'disabled_flag_off' },
      'an allow-listed caller is still refused while the flag is off',
    );

    const onWithNoList = loadC0Config({ VOICE_C0_ENABLED: 'true' });
    assert.deepEqual(
      evaluateC0Gate(onWithNoList, FICTION_A),
      { allowed: false, reason: 'allowlist_empty' },
      'an empty allow-list refuses every caller',
    );
    assert.ok(
      onWithNoList.warnings.some((warning) => warning.includes('VOICE_C0_ALLOWLIST is empty')),
      'the empty allow-list with the flag on is warned about, not silently accepted',
    );

    const on = loadC0Config({
      VOICE_C0_ENABLED: 'true',
      VOICE_C0_ALLOWLIST: `${FICTION_A},${FICTION_B}`,
    });
    assert.deepEqual(
      evaluateC0Gate(on, FICTION_A),
      { allowed: true, reason: 'allowed' },
      'both gates open ⇒ allowed',
    );
    assert.deepEqual(
      evaluateC0Gate(on, '+1 (555) 123-0002'),
      { allowed: true, reason: 'allowed' },
      'formatting differences do not close the gate',
    );
    assert.deepEqual(
      evaluateC0Gate(on, undefined),
      { allowed: false, reason: 'caller_missing' },
      'a missing caller identity is refused',
    );
    assert.deepEqual(
      evaluateC0Gate(on, '+15559999999'),
      { allowed: false, reason: 'caller_not_allowlisted' },
      'an unknown caller is refused',
    );
    assert.deepEqual(
      evaluateC0Gate(on, '5551230001'),
      { allowed: false, reason: 'caller_not_allowlisted' },
      'a non-E.164 caller is refused rather than repaired',
    );
  }

  // ─── 5. Numeric env parsing falls back loudly, never silently ─────────────
  {
    const bad = loadC0Config({ VOICE_C0_ALLOWLIST: FICTION_A });
    assert.equal(bad.staleAfterMs, DEFAULT_OUTBOX_STALE_MS);

    for (const value of ['0', '-5', 'abc', '1.5', '60000ms']) {
      const parsed = loadC0Config({
        VOICE_OUTBOX_STALE_MS: value,
        VOICE_OUTBOX_MONITOR_INTERVAL_MS: value,
      });
      assert.equal(parsed.staleAfterMs, DEFAULT_OUTBOX_STALE_MS, `${value} ⇒ default window`);
      assert.equal(
        parsed.monitorIntervalMs,
        DEFAULT_OUTBOX_MONITOR_INTERVAL_MS,
        `${value} ⇒ default interval`,
      );
      assert.equal(parsed.warnings.length, 2, 'both fallbacks are warned about');
    }

    const good = loadC0Config({
      VOICE_OUTBOX_STALE_MS: '120000',
      VOICE_OUTBOX_MONITOR_INTERVAL_MS: '15000',
      VOICE_OUTBOX_PATH: 'data/canary/outbox.jsonl',
    });
    assert.equal(good.staleAfterMs, 120000);
    assert.equal(good.monitorIntervalMs, 15000);
    assert.equal(good.outboxPath, 'data/canary/outbox.jsonl');
    assert.equal(good.warnings.length, 0);
  }

  // ─── 6. Path resolution is explicit about its base ────────────────────────
  {
    const config = loadC0Config({});
    const suffix = DEFAULT_OUTBOX_PATH.split('/').join(sep);
    const one = resolveOutboxPath(config, '/base/one');
    const two = resolveOutboxPath(config, '/base/two');
    assert.ok(isAbsolute(one), 'the resolved outbox path is absolute');
    assert.ok(one.endsWith(suffix), 'the default path is appended to the supplied cwd');
    assert.notEqual(one, two, 'the cwd argument actually rebases the path');

    const absolute = loadC0Config({ VOICE_OUTBOX_PATH: resolve('/tmp/voice-outbox.jsonl') });
    assert.equal(
      resolveOutboxPath(absolute, '/base/dir'),
      resolve('/tmp/voice-outbox.jsonl'),
      'an absolute path is not re-based',
    );
  }

  // ─── 7. The operator view is redacted ────────────────────────────────────
  {
    const on = loadC0Config({
      VOICE_C0_ENABLED: 'true',
      VOICE_C0_ALLOWLIST: `${FICTION_A},${FICTION_B}`,
    });
    const view = redactedConfig(on);
    assert.equal(view.redacted, true);
    assert.equal(view.allowlistCount, 2);
    assert.deepEqual(
      [...view.allowlistMasked],
      ['+155****0001', '+155****0002'],
      'the allow-list is masked in house style',
    );
    const serialized = JSON.stringify(view);
    assert.ok(!serialized.includes(FICTION_A), 'the redacted view must not carry the raw number');
    assert.ok(!serialized.includes(FICTION_B), 'the redacted view must not carry the raw number');
    assert.ok(!/\+\d{11}/.test(serialized), 'no full E.164 number survives in the view');
  }

  // ─── 8. Source gates: default-off compare + an allow-listed read surface ──
  const sources = readdirSync(__dirname)
    .filter((entry) => entry.endsWith('.ts') && !entry.endsWith('.check.ts'))
    .sort();
  {
    const configSrc = readFileSync(resolve(__dirname, 'c0-config.ts'), 'utf-8');
    assert.ok(
      configSrc.includes("VOICE_C0_ENABLED === 'true'"),
      'the enable gate is the literal string compare (the unsafe branch is absent)',
    );
    assert.ok(
      !/VOICE_C0_ENABLED\s*!==/.test(configSrc),
      'there is no second, inverted enable path',
    );

    // The complete read surface is the documented allow-list of env names.
    const referenced = new Set(configSrc.match(/VOICE_[A-Z0-9_]+/g) ?? []);
    const allowedTokens: string[] = [...C0_ENV_NAMES, 'VOICE_C0_ENABLED_DEFAULT'];
    const unexpected = [...referenced].filter((token) => !allowedTokens.includes(token));
    assert.deepEqual(unexpected, [], 'c0-config.ts references no undocumented env key');
    for (const name of C0_ENV_NAMES) {
      assert.ok(referenced.has(name), `c0-config.ts reads ${name}`);
    }

    // ...and it reads nothing else that this repo already documents as secret.
    const envExample = readFileSync(resolve(repoRoot, '.env.example'), 'utf-8');
    const foreignNames = [...envExample.matchAll(/^([A-Z][A-Z0-9_]+)=/gm)]
      .map((match) => match[1])
      .filter((name) => !(C0_ENV_NAMES as readonly string[]).includes(name));
    assert.ok(foreignNames.length >= 10, 'the foreign-name sample is not vacuous');
    for (const name of foreignNames) {
      assert.ok(
        !configSrc.includes(name),
        `c0-config.ts must not touch the existing config surface (${name})`,
      );
    }
  }

  // ─── 9. §0 isolation surface: every C0 source, every import, no production ─
  {
    assert.deepEqual(
      sources,
      [
        'blocks.ts',
        'c0-config.ts',
        'c0-controller.ts',
        'c0-entry.ts',
        'outbox-monitor.ts',
        'outbox.ts',
        'transfer-adapter.ts',
        'transport.ts',
      ],
      'the scan saw exactly the C0 sources — foundation, contracts, content and transport',
    );

    const forbidden: ReadonlyArray<readonly [string, RegExp]> = [
      ['the production relay module', /voice-server/i],
      ['the production relay protocol', /conversationrelay/i],
      ['the telephony provider', /twilio/i],
      ['the realtime transport vendor', /livekit/i],
      ['a third-party model provider', /openai/i],
      ['the CRM vendor', /housecall/i],
      ['the hypervisor host', /proxmox/i],
      ['the deploy host', /ct102/i],
      ['an embedded SQL database', /sqlite/i],
      ['a third-party HTTP/client package', /axios|@mastra|node-fetch|\bzod\b/i],
      ['a network call', /\bfetch\s*\(|node:https?|node:net|node:dns|WebSocket/i],
      ['a subprocess', /child_process|spawnSync|spawn\s*\(/i],
      ['a daemon/process shape', /setInterval|setTimeout|\.listen\s*\(|process\.exit/i],
      ['the CRM abbreviation', /\bhcp\b/i],
      ['a CommonJS require', /\brequire\s*\(/],
    ];

    for (const file of sources) {
      const src = readFileSync(resolve(__dirname, file), 'utf-8');

      const specifiers = [...src.matchAll(/(?:from\s+|import\s*\(\s*)'([^']+)'/g)].map(
        (match) => match[1],
      );
      assert.ok(specifiers.length > 0, `${file} declares its imports explicitly`);
      for (const specifier of specifiers) {
        assert.ok(
          specifier.startsWith('node:') || specifier.startsWith('./'),
          `${file} may import only node builtins or C0-local siblings (saw ${specifier})`,
        );
      }

      for (const [label, pattern] of forbidden) {
        assert.ok(!pattern.test(src), `${file} must not reference ${label}`);
      }
    }

    // The monitor is the strictest case: no runtime import at all.
    const monitorSrc = readFileSync(resolve(__dirname, 'outbox-monitor.ts'), 'utf-8');
    assert.equal(
      [...monitorSrc.matchAll(/^\s*import\s+(?!type\b)/gm)].length,
      0,
      'outbox-monitor.ts has zero runtime imports',
    );
    assert.ok(/^import type /m.test(monitorSrc), 'outbox-monitor.ts imports types only');
    assert.ok(!monitorSrc.includes('node:'), 'outbox-monitor.ts references no builtin module');
  }

  // ─── 10. The checks never touch the repo's own outbox path ───────────────
  {
    assert.equal(
      existsSync(resolve(repoRoot, DEFAULT_OUTBOX_PATH)),
      false,
      'no check may create the repo default outbox file',
    );
    assert.ok(!existsSync(resolve(repoRoot, 'data/voice-outbox.jsonl.tmp')));
  }

  console.log('c0-config.check OK');
}

main();
