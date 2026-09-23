'use strict';

const { twiml: { VoiceResponse } } = require('twilio');

const DISCLOSURE = 'You are speaking with an automated assistant for Grizzly Electrical. You can ask for a person at any time.';
const EMERGENCY_NOTICE = 'If this is an emergency, such as fire, smoke, a shock, or a downed line, hang up and call 911.';
const FALLBACK_COPY = 'Let me connect you with someone from the office.';
const VOICEMAIL_COPY = 'No one is available right now. Please leave your name, number, and a short message after the tone. The office will review your request and contact you.';

function response() {
  return new VoiceResponse();
}

function required(context, name) {
  const value = context && context[name];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`missing_${name}`);
  }
  return value.trim();
}

function positiveInteger(context, name) {
  const value = Number(required(context, name));
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`invalid_${name}`);
  }
  return value;
}

function boundedInteger(context, name, minimum, maximum, fallback) {
  const configured = context && context[name];
  if (configured === undefined || configured === null || configured === '') return fallback;
  const value = Number(configured);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`invalid_${name}`);
  }
  return value;
}

function sipTransport(context) {
  const configured = context && context.C0_SIP_TRANSPORT;
  const transport = typeof configured === 'string' && configured.trim() !== ''
    ? configured.trim().toLowerCase()
    : 'tcp';
  if (transport !== 'tcp' && transport !== 'tls') {
    throw new Error('invalid_C0_SIP_TRANSPORT');
  }
  return transport;
}

function sipSecure(context) {
  const configured = context && context.C0_SIP_SECURE;
  if (configured === undefined || configured === null || configured === '') {
    return false;
  }
  if (configured === 'true') {
    return true;
  }
  if (configured === 'false') {
    return false;
  }
  throw new Error('invalid_C0_SIP_SECURE');
}

function sipUri(did, host, transport, secure, callSid) {
  const security = secure ? ';secure=true' : '';
  return `sip:${did}@${host};transport=${transport}${security}?X-C0-Call=${encodeURIComponent(callSid)}`;
}

function fallbackTwiml() {
  const twiml = response();
  twiml.redirect('/fallback');
  return twiml;
}

function isAnswered(event) {
  return event && event.DialCallStatus === 'completed' && Number(event.DialCallDuration) > 0;
}

function isHumanBridged(event) {
  return Boolean(event) && event.DialBridged === 'true';
}

function normalizedRole(event) {
  return event && event.role === 'backup' ? 'backup' : 'office';
}

function voicemailTwiml() {
  const twiml = response();
  twiml.say(VOICEMAIL_COPY);
  twiml.record({
    maxLength: 120,
    playBeep: true,
    recordingStatusCallback: '/voicemail-done',
    recordingStatusCallbackMethod: 'POST',
  });
  return twiml;
}

function callbackWith(callback, twiml) {
  callback(null, twiml);
}

function syncDocuments(context) {
  const serviceSid = required(context, 'C0_SYNC_SERVICE_SID');
  const client = context.getTwilioClient();
  return { client, documents: client.sync.v1.services(serviceSid).documents };
}

function dataObject(document) {
  if (!document || !document.data || typeof document.data !== 'object') return {};
  return document.data;
}

function isConflict(error) {
  return error && (error.status === 409 || error.code === 409);
}

function isRevisionConflict(error) {
  return error && (error.status === 412 || error.code === 412);
}

function isTerminalCallStatus(status) {
  return ['completed', 'failed', 'busy', 'no-answer', 'canceled'].includes(String(status || '').toLowerCase());
}

function isMissing(error) {
  return error && error.status === 404;
}

async function acquireLease(context, callSid, timeLimit) {
  const { client, documents } = syncDocuments(context);
  const data = { callSid, acquiredAt: new Date().toISOString() };
  try {
    await documents.create({ uniqueName: 'c0-lease', data, ttl: timeLimit + 120 });
    return true;
  } catch (error) {
    if (!isConflict(error)) throw error;
  }

  const current = await documents('c0-lease').fetch();
  const currentCallSid = dataObject(current).callSid;
  if (currentCallSid === callSid) return true;
  let canTakeOver = currentCallSid === null;
  if (!canTakeOver) {
    if (typeof currentCallSid !== 'string' || currentCallSid === '') return false;
    try {
      canTakeOver = isTerminalCallStatus((await client.calls(currentCallSid).fetch()).status);
    } catch (error) {
      canTakeOver = isMissing(error);
    }
  }
  if (!canTakeOver) return false;
  try {
    await documents(current.sid || 'c0-lease').update({
      ifMatch: current.revision,
      data,
      ttl: timeLimit + 120,
    });
    return true;
  } catch (error) {
    if (isRevisionConflict(error)) return false;
    throw error;
  }
}

async function releaseLease(context, callSid) {
  try {
    const { documents } = syncDocuments(context);
    const current = await documents('c0-lease').fetch();
    if (dataObject(current).callSid === callSid) {
      await documents(current.sid || 'c0-lease').update({
        ifMatch: current.revision,
        data: { callSid: null, releasedAt: new Date().toISOString() },
      });
    }
  } catch {
    // A revision conflict means a newer holder won; other failures must not interrupt call control.
  }
}

async function consumeTransfer(context, parentCallSid) {
  const { documents } = syncDocuments(context);
  const current = await documents(`c0-transfer-${parentCallSid}`).fetch();
  const role = dataObject(current).role;
  if (role !== 'office' && role !== 'backup') throw new Error('invalid_transfer_role');
  await documents(current.sid || `c0-transfer-${parentCallSid}`).remove();
  return role;
}

/**
 * A positive admission is deliberately distinct from SIP connection.  A Dial
 * can complete after the agent immediately refuses it, so only an agent-written
 * admission document may authorize the completed-Dial hangup path.  Removal is
 * best effort: consumption is a cleanup concern, not a reason to strand an
 * already admitted caller.
 */
async function admissionForParent(context, parentCallSid) {
  const { documents } = syncDocuments(context);
  const uniqueName = `c0-admitted-${parentCallSid}`;
  const current = await documents(uniqueName).fetch();
  return {
    async remove() {
      try {
        await documents(current.sid || uniqueName).remove();
      } catch {
        // The one-shot admission TTL is the backstop when best-effort deletion fails.
      }
    },
  };
}

module.exports = {
  DISCLOSURE,
  EMERGENCY_NOTICE,
  FALLBACK_COPY,
  VOICEMAIL_COPY,
  callbackWith,
  acquireLease,
  boundedInteger,
  admissionForParent,
  consumeTransfer,
  fallbackTwiml,
  isAnswered,
  isHumanBridged,
  normalizedRole,
  positiveInteger,
  required,
  response,
  releaseLease,
  sipSecure,
  sipTransport,
  sipUri,
  voicemailTwiml,
};
