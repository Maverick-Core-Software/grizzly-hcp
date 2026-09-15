/**
 * Self-check for the ConversationRelay TTS attributes in voice-server.ts.
 *
 * The repo has no test framework installed (node:test is built in, tsx already ships
 * as a dev dependency), so run it with:
 *
 *   npx tsx --test --test-force-exit src/agent/voice-server.twiml.test.ts
 *
 * `--test-force-exit` is required because importing voice-server.ts starts its real
 * HTTP listener; the test binds an ephemeral port (VOICE_PORT=0) so it can never
 * collide with the production server on 8765.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

// Must be set BEFORE the module under test is evaluated — its PORT const reads env at import.
process.env.VOICE_PORT = '0';

const { buildRelayTtsAttrs, normalizeTtsVoice } = await import('./voice-server.js');

test('ElevenLabs provider + default voice emits both attributes', () => {
  const attrs = buildRelayTtsAttrs('ElevenLabs', 'UgBBYS2sOqTuMpoF3BR0');
  assert.match(attrs, / ttsProvider="ElevenLabs"/, 'ttsProvider is always emitted');
  assert.match(attrs, / voice="UgBBYS2sOqTuMpoF3BR0"/, 'voice is emitted');
});

test('ttsProvider is still emitted when the voice is empty (Twilio default was the bug)', () => {
  const attrs = buildRelayTtsAttrs('ElevenLabs', '');
  assert.match(attrs, / ttsProvider="ElevenLabs"/);
  assert.doesNotMatch(attrs, / voice=/);
});

test('ElevenLabs voice ids with model/speed suffixes pass through untouched', () => {
  const attrs = buildRelayTtsAttrs('ElevenLabs', 'XrExE9yKIg1WjnnlVkGX-1.2_0.6_0.8');
  assert.match(attrs, / voice="XrExE9yKIg1WjnnlVkGX-1\.2_0\.6_0\.8"/);
});

test('legacy Polly. prefix is stripped for Amazon voices', () => {
  assert.equal(normalizeTtsVoice('Amazon', 'Polly.Joanna-Neural'), 'Joanna-Neural');
  assert.match(buildRelayTtsAttrs('Amazon', normalizeTtsVoice('Amazon', 'Polly.Joanna-Neural')), / voice="Joanna-Neural"/);
});

test('Polly. is left alone for non-Amazon providers, and bare Amazon names are untouched', () => {
  assert.equal(normalizeTtsVoice('ElevenLabs', 'Polly.Joanna-Neural'), 'Polly.Joanna-Neural');
  assert.equal(normalizeTtsVoice('Amazon', 'Joanna-Neural'), 'Joanna-Neural');
  assert.equal(normalizeTtsVoice('Amazon', 'Matthew'), 'Matthew');
});
