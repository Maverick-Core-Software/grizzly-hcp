import twilio from 'twilio';
import { readFile, realpath, stat } from 'node:fs/promises';
import { basename, extname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isEntryPoint, mask, parseFlag, printSafe, safeFailureMessage, sha256, writeEvidence } from './lib.js';

const SNAPSHOT_FIELDS = [
  'voice_url', 'voice_method', 'voice_fallback_url', 'voice_fallback_method', 'voice_application_sid',
  'voice_caller_id_lookup', 'voice_receive_mode', 'sms_url', 'sms_method', 'sms_fallback_url',
  'sms_fallback_method', 'sms_application_sid', 'trunk_sid', 'status_callback', 'status_callback_method',
  'emergency_status', 'emergency_address_sid', 'emergency_address_status', 'bundle_sid', 'address_sid', 'identity_sid',
] as const;

type SnapshotField = typeof SNAPSHOT_FIELDS[number];
type SnapshotValue = string | boolean | null;
type ParentNumber = {
  sid: string;
  voiceUrl?: string | null; voiceMethod?: string | null; voiceFallbackUrl?: string | null; voiceFallbackMethod?: string | null; voiceApplicationSid?: string | null;
  voiceCallerIdLookup?: boolean | null; voiceReceiveMode?: string | null;
  smsUrl?: string | null; smsMethod?: string | null; smsFallbackUrl?: string | null; smsFallbackMethod?: string | null; smsApplicationSid?: string | null;
  trunkSid?: string | null; statusCallback?: string | null; statusCallbackMethod?: string | null;
  emergencyStatus?: string | null; emergencyAddressSid?: string | null; emergencyAddressStatus?: string | null;
  bundleSid?: string | null; addressSid?: string | null; identitySid?: string | null;
};
type GuardClient = { api: { v2010: { accounts: (sid: string) => { incomingPhoneNumbers: { list: () => Promise<ParentNumber[]> } } } } };
export type ProductionSnapshot = { parent_account_sid: string | undefined; numbers: Array<{ number_sid: string | undefined; fields_sha256: string }> };

function snapshotFields(number: ParentNumber): Record<SnapshotField, SnapshotValue> {
  return {
    voice_url: number.voiceUrl ?? null,
    voice_method: number.voiceMethod ?? null,
    voice_fallback_url: number.voiceFallbackUrl ?? null,
    voice_fallback_method: number.voiceFallbackMethod ?? null,
    voice_application_sid: number.voiceApplicationSid ?? null,
    voice_caller_id_lookup: number.voiceCallerIdLookup ?? null,
    voice_receive_mode: number.voiceReceiveMode ?? null,
    sms_url: number.smsUrl ?? null,
    sms_method: number.smsMethod ?? null,
    sms_fallback_url: number.smsFallbackUrl ?? null,
    sms_fallback_method: number.smsFallbackMethod ?? null,
    sms_application_sid: number.smsApplicationSid ?? null,
    trunk_sid: number.trunkSid ?? null,
    status_callback: number.statusCallback ?? null,
    status_callback_method: number.statusCallbackMethod ?? null,
    emergency_status: number.emergencyStatus ?? null,
    emergency_address_sid: number.emergencyAddressSid ?? null,
    emergency_address_status: number.emergencyAddressStatus ?? null,
    bundle_sid: number.bundleSid ?? null,
    address_sid: number.addressSid ?? null,
    identity_sid: number.identitySid ?? null,
  };
}

export async function snapshotProductionGuard(client: GuardClient, parentAccountSid: string): Promise<ProductionSnapshot> {
  const numbers = await client.api.v2010.accounts(parentAccountSid).incomingPhoneNumbers.list();
  return {
    parent_account_sid: mask(parentAccountSid),
    numbers: numbers
      .map((number) => ({
        number_sid: mask(number.sid),
        fields_sha256: sha256(JSON.stringify(snapshotFields(number))),
      }))
      .sort((a, b) => (a.number_sid ?? '').localeCompare(b.number_sid ?? '')),
  };
}

export function diffProductionSnapshots(previous: ProductionSnapshot, current: ProductionSnapshot): string[] {
  const oldHashes = new Map(previous.numbers.map((number) => [number.number_sid, number.fields_sha256]));
  const currentHashes = new Map(current.numbers.map((number) => [number.number_sid, number.fields_sha256]));
  const allNumbers = new Set([...oldHashes.keys(), ...currentHashes.keys()]);
  return [...allNumbers].filter((numberSid) => oldHashes.get(numberSid) !== currentHashes.get(numberSid)).map((numberSid) => `number ${numberSid ?? '[masked]'} changed`).sort();
}

function requiredOperatorEnv(name: 'C0_OPERATOR_PARENT_ACCOUNT_SID' | 'C0_OPERATOR_PARENT_AUTH_TOKEN'): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required operator environment variable: ${name}`);
  return value;
}

type CompareFileSystem = {
  realpath: (path: string) => Promise<string>;
  stat: (path: string) => Promise<{ isFile(): boolean }>;
};

const compareFileSystem: CompareFileSystem = { realpath, stat };
const EVIDENCE_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), 'evidence');

function isEnvironmentLikeName(path: string): boolean {
  return /(^|[._-])env(?:[._-]|$)/i.test(basename(path));
}

/** Resolves only an existing JSON evidence file under this provisioner's evidence root. */
export async function resolveCompareEvidencePath(comparePath: string, fileSystem: CompareFileSystem = compareFileSystem, evidenceRoot = EVIDENCE_ROOT): Promise<string> {
  if (isEnvironmentLikeName(comparePath)) throw new Error('Refusing environment-like --compare filename');
  if (extname(basename(comparePath)) !== '.json') throw new Error('Refusing --compare path that is not a JSON evidence file');
  const [resolvedRoot, resolvedFile] = await Promise.all([fileSystem.realpath(evidenceRoot), fileSystem.realpath(comparePath)]);
  const withinRoot = relative(resolvedRoot, resolvedFile);
  if (!withinRoot || withinRoot.startsWith('..') || isAbsolute(withinRoot)) throw new Error('Refusing --compare path outside provision evidence');
  if (!(await fileSystem.stat(resolvedFile)).isFile()) throw new Error('Refusing --compare path that is not a regular file');
  return resolvedFile;
}

async function readSnapshot(path: string): Promise<ProductionSnapshot> {
  return JSON.parse(await readFile(path, 'utf8')) as ProductionSnapshot;
}

async function main(): Promise<void> {
  const parentAccountSid = requiredOperatorEnv('C0_OPERATOR_PARENT_ACCOUNT_SID');
  const authToken = requiredOperatorEnv('C0_OPERATOR_PARENT_AUTH_TOKEN');
  const comparePath = parseFlag(process.argv, '--compare');
  const compareEvidencePath = comparePath ? await resolveCompareEvidencePath(comparePath) : undefined;
  const result = await snapshotProductionGuard(twilio(parentAccountSid, authToken) as unknown as GuardClient, parentAccountSid);
  const changes = compareEvidencePath ? diffProductionSnapshots(await readSnapshot(compareEvidencePath), result) : [];
  const evidence = { ...result, comparison: comparePath ? { pass: changes.length === 0, changes } : undefined };
  await writeEvidence('snapshot-production-guard', evidence);
  printSafe(evidence);
  if (changes.length) process.exitCode = 1;
}

if (isEntryPoint(import.meta.url)) main().catch((error) => { console.error(safeFailureMessage(error, 'production guard')); process.exitCode = 1; });
