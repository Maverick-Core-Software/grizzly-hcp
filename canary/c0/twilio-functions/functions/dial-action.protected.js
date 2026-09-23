'use strict';

const c0 = require('./lib/c0.private');

async function buildDialActionTwiml(context, event) {
  const parentCallSid = event && (event.ParentCallSid || event.CallSid);
  let transferRole;
  try {
    transferRole = await c0.consumeTransfer(context, parentCallSid);
  } catch (error) {
    if (!(error && error.status === 404)) return c0.fallbackTwiml();
  }
  if (transferRole) {
    const twiml = c0.response();
    twiml.redirect(`/fallback?role=${transferRole}`);
    return twiml;
  }
  let admission;
  try {
    admission = await c0.admissionForParent(context, parentCallSid);
  } catch (error) {
    if (!(error && error.status === 404)) return c0.fallbackTwiml();
  }
  if (admission && c0.isAnswered(event)) {
    await admission.remove();
    const twiml = c0.response();
    twiml.hangup();
    return twiml;
  }
  return c0.fallbackTwiml();
}

exports.handler = (context, event, callback) => {
  void buildDialActionTwiml(context, event)
    .then(async (twiml) => {
      await c0.releaseLease(context, event && (event.ParentCallSid || event.CallSid));
      c0.callbackWith(callback, twiml);
    })
    .catch(() => c0.callbackWith(callback, c0.fallbackTwiml()));
};

exports.buildDialActionTwiml = buildDialActionTwiml;
