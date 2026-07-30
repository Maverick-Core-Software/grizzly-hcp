/**
 * Pure contract shared by the customer SMS webhook and estimate runner.
 *
 * The agent may suggest an ESTIMATE_READY block, but the webhook supplies the
 * trusted phone number and derives the idempotency key.  Nothing in this file
 * opens a socket, sends a message, or writes to Housecall Pro.
 */
import { z, ZodError } from 'zod';

const MAX_SCOPE_LENGTH = 4_000;
const MAX_ADDRESS_LENGTH = 500;

function blankToUndefined(value: unknown): unknown {
  return typeof value === 'string' && value.trim() === '' ? undefined : value;
}

function trimmedString(max: number) {
  return z.preprocess(
    value => typeof value === 'string' ? value.trim() : value,
    z.string().min(1).max(max),
  );
}

const optionalEmail = z.preprocess(
  blankToUndefined,
  z.string().trim().email().max(320).optional(),
);

const optionalLeadSource = z.preprocess(
  blankToUndefined,
  z.string().trim().min(1).max(200).optional(),
);

/** Normalizes common US/Twilio phone representations without accepting junk. */
export function normalizeSmsPhone(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;

  const digits = trimmed.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (trimmed.startsWith('+') && digits.length >= 8 && digits.length <= 15) return `+${digits}`;
  return undefined;
}

const phone = z.preprocess(
  value => typeof value === 'string' ? normalizeSmsPhone(value) : value,
  z.string().regex(/^\+[1-9]\d{7,14}$/),
);

/**
 * This is deliberately strict.  New fields must be reviewed before they can
 * influence CRM behavior, rather than silently passing through from the LLM.
 */
export const SmsEstimateReadySchema = z.object({
  scope: trimmedString(MAX_SCOPE_LENGTH),
  customerName: trimmedString(200),
  customerPhone: phone,
  customerAddress: trimmedString(MAX_ADDRESS_LENGTH),
  customerEmail: optionalEmail,
  leadSource: optionalLeadSource,
  depositPercent: z.number().finite().min(0).max(100).optional(),
  siteWalk: z.boolean().optional(),
}).strict();

export type SmsEstimateReady = z.infer<typeof SmsEstimateReadySchema>;

export interface SmsEstimateIntake extends SmsEstimateReady {
  /** Deterministic event-derived key passed to the existing idempotent workflow. */
  operationId: string;
}

export type SmsIntakeReviewReason =
  | 'invalid_estimate_ready'
  | 'unexpected_field'
  | 'missing_scope'
  | 'missing_customer_name'
  | 'missing_customer_phone'
  | 'missing_customer_address'
  | 'phone_mismatch'
  | 'invalid_operation_id';

export type SmsIntakeDecision =
  | { kind: 'ready'; intake: SmsEstimateIntake }
  | { kind: 'review'; reason: SmsIntakeReviewReason };

export interface ParseSmsEstimateReadyOptions {
  /** The phone received from the signed Twilio webhook, not an LLM assertion. */
  trustedInboundPhone: string;
  /** Derived from the claimed MessageSid before work is started. */
  operationId: string;
}

/**
 * Creates a stable workflow key from a Twilio MessageSid.  It intentionally
 * uses no timestamp/randomness, so webhook retries reach the same operation.
 */
export function deriveSmsOperationId(messageSid: string): string | undefined {
  const sid = messageSid.trim();
  return /^[A-Za-z0-9_-]{8,128}$/.test(sid) ? `sms-${sid}` : undefined;
}

function reasonForValidationError(error: ZodError): SmsIntakeReviewReason {
  const issue = error.issues[0];
  if (!issue) return 'invalid_estimate_ready';
  if (issue.code === 'unrecognized_keys') return 'unexpected_field';
  const field = issue.path[0];
  if (field === 'scope') return 'missing_scope';
  if (field === 'customerName') return 'missing_customer_name';
  if (field === 'customerPhone') return 'missing_customer_phone';
  if (field === 'customerAddress') return 'missing_customer_address';
  return 'invalid_estimate_ready';
}

/**
 * Validates an agent block and binds it to signed webhook context.  A malformed
 * block is an operator-review result, never an exception that can accidentally
 * continue to the estimate runner.
 */
export function parseSmsEstimateReady(
  value: unknown,
  options: ParseSmsEstimateReadyOptions,
): SmsIntakeDecision {
  const operationId = options.operationId.trim();
  if (!/^sms-[A-Za-z0-9_-]{8,128}$/.test(operationId)) {
    return { kind: 'review', reason: 'invalid_operation_id' };
  }

  const trustedInboundPhone = normalizeSmsPhone(options.trustedInboundPhone);
  if (!trustedInboundPhone) return { kind: 'review', reason: 'missing_customer_phone' };

  const parsed = SmsEstimateReadySchema.safeParse(value);
  if (!parsed.success) return { kind: 'review', reason: reasonForValidationError(parsed.error) };
  if (parsed.data.customerPhone !== trustedInboundPhone) {
    return { kind: 'review', reason: 'phone_mismatch' };
  }

  return { kind: 'ready', intake: { ...parsed.data, operationId } };
}

/** Copy used only after the estimate was actually delivered through these channels. */
export function buildSmsEstimateCompletionMessage(input: { customerEmail?: string }): string {
  const delivery = input.customerEmail ? 'by text and email' : 'by text';
  return `Your estimate has been sent ${delivery}. Please review and approve it; we'll confirm your appointment time after approval.`;
}

// Dependency boundaries for the HTTP adapter added in the delivery session.
export interface SmsAgentGenerator {
  generate(prompt: string): Promise<{ text?: unknown }>;
}

export interface SmsEstimateRunner {
  run(input: SmsEstimateIntake): Promise<{
    success: boolean;
    estimateUuid?: string;
    estimateUrl?: string;
    reviewReason?: SmsIntakeReviewReason;
    errorCategory?: string;
  }>;
}

export interface SmsSender {
  send(input: { to: string; body: string; from?: string }): Promise<void>;
}

export interface SmsClock {
  now(): Date;
}

export type SmsInboundEventStatus = 'claimed' | 'completed' | 'review' | 'failed';

export interface SmsInboundEventClaimStore {
  claim(input: { messageSid: string; operationId: string; receivedAt: Date }): Promise<
    | { claimed: true }
    | { claimed: false; status: SmsInboundEventStatus; operationId: string }
  >;
  mark(input: {
    messageSid: string;
    status: Exclude<SmsInboundEventStatus, 'claimed'>;
    reviewReason?: SmsIntakeReviewReason;
  }): Promise<void>;
}
