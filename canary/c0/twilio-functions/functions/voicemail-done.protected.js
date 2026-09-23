'use strict';

const c0 = require('./lib/c0.private');
const RECORDING_SID = /^RE[0-9a-fA-F]{32}$/;
const CALL_SID = /^CA[0-9a-fA-F]{32}$/;

function alertBody(recordingSid, callSid) {
  const safeRecording = typeof recordingSid === 'string' && RECORDING_SID.test(recordingSid) ? recordingSid : 'unknown';
  const safeCall = typeof callSid === 'string' && CALL_SID.test(callSid) ? `${callSid.slice(0, 6)}…` : 'unknown';
  return JSON.stringify({ event: 'c0_voicemail_received', recordingSid: safeRecording, callSid: safeCall });
}

async function postRedactedAlert(topic, recordingSid, callSid, fetchImpl) {
  if (typeof topic !== 'string' || topic.trim() === '' || typeof fetchImpl !== 'function') return;
  try {
    await fetchImpl(`https://ntfy.sh/${encodeURIComponent(topic.trim())}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: alertBody(recordingSid, callSid) });
  } catch { /* Alerts are deliberately non-blocking for the caller. */ }
}

exports.handler = (context, event, callback) => {
  const fetchImpl = typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : undefined;
  void Promise.all([postRedactedAlert(context && context.C0_NTFY_TOPIC, event && event.RecordingSid, event && event.CallSid, fetchImpl), c0.releaseLease(context, event && event.CallSid)])
    .finally(() => callback(null, ''));
};
exports.alertBody = alertBody;
exports.postRedactedAlert = postRedactedAlert;
