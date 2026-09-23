'use strict';

const c0 = require('./lib/c0.private');

async function buildIngressTwiml(context, event) {
  const allowedCallers = c0.required(context, 'C0_ALLOWED_CALLERS').split(',').map((item) => item.trim()).filter(Boolean);
  const sipHost = c0.required(context, 'C0_LIVEKIT_SIP_HOST');
  const sipUsername = c0.required(context, 'C0_SIP_USERNAME');
  const sipPassword = c0.required(context, 'C0_SIP_PASSWORD');
  const did = c0.required(context, 'C0_CANARY_DID');
  const timeout = c0.boundedInteger(context, 'C0_DIAL_TIMEOUT_S', 5, 600, 20);
  const timeLimit = c0.boundedInteger(context, 'C0_TIME_LIMIT_S', 60, 14400, 480);
  const transport = c0.sipTransport(context);
  const secure = c0.sipSecure(context);
  const callSid = event && event.CallSid;

  if (typeof callSid !== 'string' || callSid === '' || !allowedCallers.includes(event.From)) {
    return c0.fallbackTwiml();
  }

  if (!await c0.acquireLease(context, callSid, timeLimit)) {
    return c0.fallbackTwiml();
  }

  const twiml = c0.response();
  twiml.say(c0.DISCLOSURE);
  twiml.say(c0.EMERGENCY_NOTICE);
  const dial = twiml.dial({
    action: '/dial-action',
    timeout,
    answerOnBridge: true,
    timeLimit,
  });
  dial.sip({ username: sipUsername, password: sipPassword }, c0.sipUri(did, sipHost, transport, secure, callSid));
  return twiml;
}

exports.handler = (context, event, callback) => {
  void buildIngressTwiml(context, event)
    .then((twiml) => c0.callbackWith(callback, twiml))
    .catch(() => c0.callbackWith(callback, c0.fallbackTwiml()));
};

exports.buildIngressTwiml = buildIngressTwiml;
