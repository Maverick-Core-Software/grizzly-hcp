'use strict';

const c0 = require('./lib/c0.private');

function buildFallbackTwiml(context, event) {
  const role = c0.normalizedRole(event);
  const numberName = role === 'backup' ? 'C0_BACKUP_NUMBER' : 'C0_OFFICE_NUMBER';
  let destination;
  try { destination = c0.required(context, numberName); } catch { return c0.voicemailTwiml(); }
  const twiml = c0.response();
  twiml.say(c0.FALLBACK_COPY);
  const dial = twiml.dial({ action: `/fallback-next?role=${role}`, timeout: 20 });
  dial.number({ url: '/whisper', method: 'POST' }, destination);
  return twiml;
}

exports.handler = (context, event, callback) => c0.callbackWith(callback, buildFallbackTwiml(context, event));
exports.buildFallbackTwiml = buildFallbackTwiml;
