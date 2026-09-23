'use strict';

const c0 = require('./lib/c0.private');

function buildWhisperTwiml(event) {
  const twiml = c0.response();
  if (event && event.Digits === '1') return twiml;
  const gather = twiml.gather({ numDigits: 1, action: '/whisper', method: 'POST' });
  gather.say('Grizzly canary call. Press 1 to accept.');
  twiml.hangup();
  return twiml;
}

exports.handler = (context, event, callback) => c0.callbackWith(callback, buildWhisperTwiml(event));
exports.buildWhisperTwiml = buildWhisperTwiml;
