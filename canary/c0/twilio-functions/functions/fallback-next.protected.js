'use strict';

const c0 = require('./lib/c0.private');

function buildFallbackNextTwiml(event) {
  if (c0.isHumanBridged(event)) { const twiml = c0.response(); twiml.hangup(); return twiml; }
  if (c0.normalizedRole(event) === 'office') { const twiml = c0.response(); twiml.redirect('/fallback?role=backup'); return twiml; }
  return c0.voicemailTwiml();
}

exports.handler = (context, event, callback) => c0.callbackWith(callback, buildFallbackNextTwiml(event));
exports.buildFallbackNextTwiml = buildFallbackNextTwiml;
