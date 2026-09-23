export const E164_RE = /^\+[1-9]\d{7,14}$/;

export interface ParentCallLookupClient {
  calls(callSid: string): { fetch(): Promise<{ from?: string | null }> };
}

/** The caller's number remains in Twilio; it is never copied into SIP attributes. */
export async function fetchAllowedCaller(
  client: ParentCallLookupClient,
  parentCallSid: string,
  allowlist: readonly string[],
): Promise<string | null> {
  try {
    const from = (await client.calls(parentCallSid).fetch()).from?.trim();
    if (!from || !E164_RE.test(from) || !allowlist.includes(from)) return null;
    return from;
  } catch {
    return null;
  }
}
