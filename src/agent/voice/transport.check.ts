/**
 * Self-check for the C0 transport contract. No test framework — run from the
 * worktree root with:
 *
 *   npx tsx src/agent/voice/transport.check.ts
 *
 * In-repo sources only: no network, no credentials, no socket, no timer, no
 * process, nothing started and nothing written. The admitted handle used as the
 * fixture is minted by the real entry contract, so the "valid handle" path is
 * exercised through the actual local interface rather than a hand-built stub.
 * Phone-like fixtures use the reserved fictional range (555-01xx).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadC0Config } from './c0-config.js';
import { maskPhone } from './outbox.js';
import {
  MAX_UTTERANCE_CHARS,
  admitC0Ingress,
  type C0AdmittedIngress,
} from './c0-entry.js';
import {
  C0_INERT_PHASES,
  C0_TRANSPORT_INERT_FIELDS,
  C0_TRANSPORT_PHASES,
  C0_TRANSPORT_PLAN_FIELDS,
  canEnterC0Phase,
  createC0TransportContract,
  nextC0Phase,
  planC0Transport,
  transportCapability,
  type C0TransportInertResult,
  type C0TransportPlan,
  type C0TransportRefusalReason,
  type C0TransportResult,
} from './transport.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const FICTION_E164_A = '+15551230001';
const FICTION_MASK_A = '+155****0001';

const OFF = loadC0Config({});
const ON_EMPTY_ALLOWLIST = loadC0Config({ VOICE_C0_ENABLED: 'true' });
const ON = loadC0Config({
  VOICE_C0_ENABLED: 'true',
  VOICE_C0_ALLOWLIST: FICTION_E164_A,
});

const UTTERANCE = 'the panel is buzzing near the meter';

/** A genuinely admitted handle, produced by the real entry contract. */
const HANDLE: C0AdmittedIngress = (() => {
  const result = admitC0Ingress(ON, {
    source: 'transport',
    correlationId: 'CA-c0-2001',
    callerE164: FICTION_E164_A,
    intentSequence: 5,
    payloadVersion: 1,
    utterance: UTTERANCE,
  });
  assert.equal(result.status, 'admitted', 'the fixture handle must really be admitted');
  return result as C0AdmittedIngress;
})();

function isPlanned(result: C0TransportResult): result is C0TransportPlan {
  return result.status === 'planned';
}

function expectInert(
  result: C0TransportResult,
  reason: C0TransportRefusalReason,
): C0TransportInertResult {
  assert.ok(!isPlanned(result), `expected an inert result, saw ${result.status}`);
  assert.equal(result.performed, false, 'an inert result performed nothing');
  assert.equal(result.delivered, false, 'an inert result delivered nothing');
  assert.equal(result.connected, false, 'an inert result connected nothing');
  assert.equal(result.dispatched, false, 'an inert result dispatched nothing');
  assert.equal(result.callerVisible, false, 'an inert result reached no caller');
  assert.deepEqual(Object.keys(result).sort(), [...C0_TRANSPORT_INERT_FIELDS], 'closed inert shape');
  assert.equal(result.reason, reason);
  return result;
}

function expectPlanned(result: C0TransportResult): C0TransportPlan {
  assert.ok(isPlanned(result), `expected a plan, saw ${result.status}`);
  assert.equal(result.phase, 'ready');
  assert.equal(result.performed, false, 'a plan is not an action');
  assert.equal(result.delivered, false, 'a plan is not a delivery');
  assert.equal(result.connected, false, 'a plan is not a connection');
  assert.equal(result.dispatched, false, 'a plan carries no media');
  assert.equal(result.callerVisible, false, 'a plan reaches no caller');
  assert.deepEqual(Object.keys(result).sort(), [...C0_TRANSPORT_PLAN_FIELDS], 'closed plan shape');
  return result;
}

/** A handle with one field replaced, or an extra field added. */
function forged(override: Record<string, unknown>): Record<string, unknown> {
  return { ...HANDLE, ...override };
}

/** A handle with one field missing entirely. */
function dropped(field: string): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...HANDLE };
  delete copy[field];
  return copy;
}

function main(): void {
  // ─── 0. Fixture sanity ───────────────────────────────────────────────────
  {
    assert.equal(HANDLE.callerMasked, FICTION_MASK_A);
    assert.equal(maskPhone(FICTION_E164_A), FICTION_MASK_A);
    assert.equal(HANDLE.status, 'admitted');
    assert.deepEqual(
      [...C0_TRANSPORT_PHASES],
      ['admitted', 'ready', 'connecting', 'active', 'ended'],
      'the lifecycle vocabulary is closed and ordered',
    );
    assert.deepEqual([...C0_INERT_PHASES], ['admitted', 'ready']);
  }

  // ─── 1. Non-admitted ingress is refused, typed ──────────────────────────
  {
    const notHandles: unknown[] = [
      null,
      undefined,
      'admitted',
      42,
      true,
      [],
      [HANDLE],
      () => HANDLE,
      new Date(0),
      // A raw ingress is not a handle...
      { source: 'transport', correlationId: 'CA-c0-2002', callerE164: FICTION_E164_A },
      // ...and neither is an admission REFUSAL.
      admitC0Ingress(OFF, {
        source: 'transport',
        correlationId: 'CA-c0-2003',
        callerE164: FICTION_E164_A,
      }),
      // ...nor is a transport plan.
      { status: 'planned', phase: 'ready' },
    ];
    for (const value of notHandles) {
      expectInert(planC0Transport(ON, value), 'transport_ingress_not_admitted');
    }
  }

  // ─── 2. A handle is re-verified, never trusted ──────────────────────────
  {
    const mutations: ReadonlyArray<readonly [string, unknown]> = [
      ['a missing caller reference', dropped('callerMasked')],
      ['a missing gate', dropped('gate')],
      ['a missing transcript field', dropped('utterance')],
      ['a missing correlation id', dropped('correlationId')],
      ['an extra, unrecognized field', forged({ extra: 'selftest-extra' })],
      ['a closed gate', forged({ gate: { allowed: false, reason: 'disabled_flag_off' } })],
      ['no gate at all', forged({ gate: null })],
      ['a claimed action', forged({ performed: true })],
      ['a claimed delivery', forged({ delivered: true })],
      ['a RAW caller number where a masked reference belongs', forged({ callerMasked: FICTION_E164_A })],
      ['an empty caller reference', forged({ callerMasked: '' })],
      ['an illegal correlation id', forged({ correlationId: 'CA 123' })],
      ['an illegal confirmed intent sequence', forged({ intentSequence: 0 })],
      ['an illegal payload version', forged({ payloadVersion: 0 })],
      ['an unknown source', forged({ source: 'not-a-source' })],
      ['a non-string transcript', forged({ utterance: 42 })],
      ['an over-long transcript', forged({ utterance: 'x'.repeat(MAX_UTTERANCE_CHARS + 1) })],
      ['disagreeing admission flags', forged({ status: 'inert' })],
      ['an unadmitted flag', forged({ admitted: false, status: 'admitted' })],
    ];
    for (const [label, value] of mutations) {
      const result = planC0Transport(ON, value);
      assert.equal(result.status, 'inert', `${label} must be refused`);
      expectInert(result, 'transport_ingress_handle_invalid');
    }
    // A refusal names the class of problem and echoes no value.
    const rawCarrier = expectInert(
      planC0Transport(ON, forged({ callerMasked: FICTION_E164_A })),
      'transport_ingress_handle_invalid',
    );
    assert.ok(
      !JSON.stringify(rawCarrier).includes(FICTION_E164_A),
      'a refusal must never echo the value it rejected',
    );
  }

  // ─── 3. The disabled state is refused, typed ────────────────────────────
  {
    expectInert(planC0Transport(OFF, HANDLE), 'transport_disabled');
    expectInert(
      planC0Transport(loadC0Config({ VOICE_C0_ALLOWLIST: FICTION_E164_A }), HANDLE),
      'transport_disabled',
      );
    expectInert(planC0Transport(ON_EMPTY_ALLOWLIST, HANDLE), 'transport_allowlist_empty');
    expectInert(
      planC0Transport(loadC0Config({ VOICE_C0_ENABLED: 'true', VOICE_C0_ALLOWLIST: ' , ' }), HANDLE),
      'transport_allowlist_empty',
    );
    // A broken composition is refused, not crashed on.
    expectInert(planC0Transport(null as never, HANDLE), 'transport_disabled');
  }

  // ─── 4. The INPUT is settled before the STATE ──────────────────────────
  {
    expectInert(planC0Transport(OFF, null), 'transport_ingress_not_admitted');
    expectInert(planC0Transport(OFF, { status: 'planned' }), 'transport_ingress_not_admitted');
    expectInert(planC0Transport(OFF, forged({ performed: true })), 'transport_ingress_handle_invalid');
  }

  // ─── 5. An allowed plan: inert, and it represents no connection ────────
  {
    const plan = expectPlanned(planC0Transport(ON, HANDLE));
    assert.equal(plan.status, 'planned');
    assert.equal(plan.correlationId, HANDLE.correlationId);
    assert.equal(plan.source, HANDLE.source);
    assert.equal(plan.intentSequence, HANDLE.intentSequence);
    assert.equal(plan.payloadVersion, HANDLE.payloadVersion);
    assert.equal(plan.callerMasked, HANDLE.callerMasked);
    assert.equal(plan.utteranceChars, UTTERANCE.length, 'the plan carries the transcript LENGTH');

    const serialized = JSON.stringify(plan);
    assert.ok(!serialized.includes(UTTERANCE), 'no caller text travels through the transport plan');
    assert.ok(!serialized.includes(FICTION_E164_A), 'no raw caller number reaches the plan');
    assert.ok(!/\+1?\d{10}/.test(serialized), 'no full number survives in the plan');
    assert.ok(
      !/"(url|uri|endpoint|room|token|host|port|socket|media|provider|destination|target|call)"/i.test(
        serialized,
      ),
      'a plan has no field a connection, endpoint, destination or media path could occupy',
    );
    assert.ok(!/wss?:\/\/|https?:\/\//.test(serialized), 'a plan names no endpoint');
    assert.ok(!/(connected|dispatched|performed|delivered|callerVisible)":true/.test(serialized));

    // Pure and input-preserving.
    assert.deepEqual(planC0Transport(ON, HANDLE), plan, 'planning is deterministic');
    const fresh = admitC0Ingress(ON, {
      source: 'transport',
      correlationId: 'CA-c0-2001',
      callerE164: FICTION_E164_A,
      intentSequence: 5,
      payloadVersion: 1,
      utterance: UTTERANCE,
    });
    assert.equal(fresh.status, 'admitted');
    assert.deepEqual(
      { ...HANDLE },
      { ...(fresh as C0AdmittedIngress) },
      'planning never mutates the handle it was given',
    );
  }

  // ─── 6. The lifecycle is data, and only its inert phases are reachable ─
  {
    assert.ok(Object.isFrozen(C0_TRANSPORT_PHASES), 'the phase vocabulary cannot grow');
    assert.ok(Object.isFrozen(C0_INERT_PHASES));

    for (const phase of ['admitted', 'ready']) {
      assert.equal(canEnterC0Phase(phase), true, `${phase} is inert and reachable`);
    }
    for (const phase of ['connecting', 'active', 'ended', 'live', '', 'READY', null, undefined, 42, {}, []]) {
      assert.equal(canEnterC0Phase(phase), false, `${String(phase)} is not reachable`);
    }

    const chain: Array<string | null> = [];
    let phase: string | null = 'admitted';
    while (phase !== null) {
      chain.push(phase);
      phase = nextC0Phase(phase);
    }
    assert.deepEqual(chain, ['admitted', 'ready', 'connecting', 'active', 'ended']);
    assert.equal(nextC0Phase('ended'), null, 'the model ends');
    for (const value of ['live', '', null, undefined, 42, {}]) {
      assert.equal(nextC0Phase(value), null, `${String(value)} is not a phase`);
    }

    const capability = transportCapability();
    assert.equal(capability.connects, false, 'this stage connects nothing');
    assert.equal(capability.dispatchesMedia, false, 'this stage dispatches no media');
    assert.equal(capability.callerVisible, false, 'this stage reaches no caller');
    assert.equal(capability.reason, 'not_implemented_at_this_stage');

    // The plan sits at an inert phase, and the NEXT step is one this contract
    // will not let anyone take.
    const plan = expectPlanned(planC0Transport(ON, HANDLE));
    assert.equal(canEnterC0Phase(plan.phase), true);
    const next = nextC0Phase(plan.phase);
    assert.equal(next, 'connecting');
    assert.equal(canEnterC0Phase(next), false, 'a connection is unreachable from here');

    // No source line claims otherwise.
    const src = readFileSync(resolve(__dirname, 'transport.ts'), 'utf-8');
    for (const probe of ['connects: true', 'dispatchesMedia: true', 'callerVisible: true']) {
      assert.ok(!src.includes(probe), `transport.ts must not contain ${probe}`);
    }
    assert.ok(src.includes('connects: false'), 'the capability is inert, literally');
    assert.ok(src.includes('connected: false'), 'the plan is not a connection, literally');
  }

  // ─── 7. Structural: the surfaces are constrained ───────────────────────
  {
    assert.equal(planC0Transport.length, 2, 'planning takes exactly config + ingress');
    assert.equal(canEnterC0Phase.length, 1);
    assert.equal(nextC0Phase.length, 1);
    assert.equal(transportCapability.length, 0);

    const contract = createC0TransportContract(ON);
    expectPlanned(contract.plan(HANDLE));
    expectInert(contract.plan(null), 'transport_ingress_not_admitted');
    assert.equal(contract.capability().connects, false);
    for (const bad of [null, undefined, 'config', 42]) {
      assert.throws(
        () => createC0TransportContract(bad as never),
        /c0_transport_invalid_config/,
        'a transport contract cannot exist without an explicit config',
      );
    }
  }

  // ─── 8. §0 source isolation for the transport module ───────────────────
  {
    const src = readFileSync(resolve(__dirname, 'transport.ts'), 'utf-8');

    const specifiers = [...src.matchAll(/(?:from\s+|import\s*\(\s*)'([^']+)'/g)].map((m) => m[1]);
    assert.deepEqual(
      specifiers.sort(),
      ['./c0-config.js', './c0-controller.js', './c0-entry.js'],
      'the transport composes only local C0 interfaces',
    );
    for (const specifier of specifiers) {
      assert.ok(specifier.startsWith('node:') || specifier.startsWith('./'));
    }
    assert.ok(
      !specifiers.includes('./blocks.js'),
      'a transport never chooses what a caller hears, so it holds no wording',
    );
    assert.ok(!src.includes('node:'), 'the transport references no builtin module at all');

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
      ['a third-party package', /@mastra|axios|node-fetch|\bzod\b/i],
      ['a network call', /\bfetch\s*\(|node:https?|node:net|node:dns|WebSocket|socket\./i],
      ['a subprocess', /child_process|spawnSync|spawn\s*\(/i],
      ['a daemon/process shape', /setInterval|setTimeout|\.listen\s*\(|process\.exit|process\.env/i],
      ['a CommonJS require', /\brequire\s*\(/],
      ['a dynamic import', /\bimport\s*\(/],
      ['generated code', /\beval\s*\(|new\s+Function/],
      ['an endpoint literal', /wss?:\/\/|https?:\/\/|:\/\/[a-z0-9.-]+/i],
      ['a phone-shaped literal', /\+\d{7,}/],
      ['a template slot', /\$\{/],
    ];
    for (const [label, pattern] of forbidden) {
      assert.ok(!pattern.test(src), `transport.ts must not reference ${label}`);
    }
    for (const probe of ['console.', 'Date.now', 'async', 'await ', 'Promise', 'require(']) {
      assert.ok(!src.includes(probe), `transport.ts must not contain ${probe}`);
    }
    assert.ok(src.includes('performed: false'), 'every result is marked not-performed');
    assert.ok(src.includes('delivered: false'), 'every result is marked not-delivered');
  }

  console.log('transport.check OK');
}

main();
