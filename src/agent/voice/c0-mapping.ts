/** C0 canary CallSid mapping — append-only, injected-path, fail-closed store. */
import fs from 'node:fs';
import path from 'node:path';

export const C0_PARENT_CALL_SID_RE = /^CA[0-9a-f]{32}$/;

export type C0MappingTerminalState = 'ended' | 'transferred' | 'failed';
export type C0MappingFailure =
  | 'mapping_invalid'
  | 'mapping_incomplete'
  | 'mapping_conflict'
  | 'mapping_unavailable';

export interface C0MappingBindInput {
  readonly parentCallSid: string;
  readonly childCallSid?: string;
  readonly trunkId: string;
  readonly ruleId: string;
  readonly roomName: string;
  readonly participantIdentity: string;
  readonly sipCallIdFull?: string;
}

export interface C0Mapping {
  readonly parentCallSid: string;
  readonly childCallSid?: string;
  readonly trunkId: string;
  readonly ruleId: string;
  readonly roomName: string;
  readonly participantIdentity: string;
  readonly sipCallIdFull?: string;
  readonly terminal: C0MappingTerminalState | null;
}

export interface C0MappingSnapshot {
  readonly redacted: true;
  readonly path: string;
  readonly total: number;
  readonly terminalCounts: Record<C0MappingTerminalState | 'open', number>;
  readonly mappings: ReadonlyArray<{
    readonly parentCallSid: string;
    readonly childCallSid?: string;
    readonly terminal: C0MappingTerminalState | null;
  }>;
}

type BindResult = { readonly ok: true; readonly mapping: C0Mapping };
type BindFailure = { readonly ok: false; readonly reason: C0MappingFailure };
type MappingUnavailable = { readonly ok: false; readonly reason: 'mapping_unavailable' };
type MappingRead =
  | { readonly ok: true; readonly mappings: Map<string, C0Mapping> }
  | MappingUnavailable;
type MappingEvent =
  | { readonly type: 'bind'; readonly mapping: C0Mapping }
  | { readonly type: 'terminal'; readonly parentCallSid: string; readonly terminal: C0MappingTerminalState };

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' && value.trim().length <= 256
    ? value.trim()
    : null;
}

function callSid(value: unknown): string | null {
  return typeof value === 'string' && C0_PARENT_CALL_SID_RE.test(value) ? value : null;
}

function normalizeBind(input: C0MappingBindInput): Omit<C0Mapping, 'terminal'> | null {
  if (input === null || typeof input !== 'object') return null;
  const parentCallSid = callSid(input.parentCallSid);
  const trunkId = text(input.trunkId);
  const ruleId = text(input.ruleId);
  const roomName = text(input.roomName);
  const participantIdentity = text(input.participantIdentity);
  if (!parentCallSid || !trunkId || !ruleId || !roomName || !participantIdentity) return null;
  const childCallSid = input.childCallSid === undefined ? undefined : callSid(input.childCallSid);
  const sipCallIdFull = input.sipCallIdFull === undefined ? undefined : text(input.sipCallIdFull);
  if (childCallSid === null || sipCallIdFull === null) {
    return null;
  }
  return {
    parentCallSid,
    ...(childCallSid === undefined ? {} : { childCallSid }),
    trunkId,
    ruleId,
    roomName,
    participantIdentity,
    ...(sipCallIdFull === undefined ? {} : { sipCallIdFull }),
  };
}

function bindFailure(input: C0MappingBindInput): C0MappingFailure {
  if (input === null || typeof input !== 'object') return 'mapping_invalid';
  if (callSid(input.parentCallSid) === null) return 'mapping_invalid';
  if (!text(input.trunkId) || !text(input.ruleId) || !text(input.roomName) || !text(input.participantIdentity)) {
    return 'mapping_incomplete';
  }
  return 'mapping_invalid';
}

function sameBinding(existing: C0Mapping, incoming: Omit<C0Mapping, 'terminal'>): boolean {
  return (
    existing.parentCallSid === incoming.parentCallSid &&
    existing.childCallSid === incoming.childCallSid &&
    existing.trunkId === incoming.trunkId &&
    existing.ruleId === incoming.ruleId &&
    existing.roomName === incoming.roomName &&
    existing.participantIdentity === incoming.participantIdentity &&
    existing.sipCallIdFull === incoming.sipCallIdFull
  );
}

function redactedCallSid(value: string): string {
  return `CA…${value.slice(-4)}`;
}

function unavailable(): MappingUnavailable {
  return { ok: false, reason: 'mapping_unavailable' };
}

function isMissingFile(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

function isTerminalState(value: unknown): value is C0MappingTerminalState {
  return value === 'ended' || value === 'transferred' || value === 'failed';
}

export class C0MappingStore {
  readonly path: string;
  private readonly filesystem: typeof fs;

  constructor(opts: { readonly path: string; readonly filesystem?: typeof fs } | string) {
    const candidate = typeof opts === 'string' ? opts : opts?.path;
    if (typeof candidate !== 'string' || candidate.trim() === '') throw new Error('mapping_invalid_path');
    this.path = candidate;
    this.filesystem = typeof opts === 'string' ? fs : (opts.filesystem ?? fs);
  }

  bind(input: C0MappingBindInput): BindResult | BindFailure {
    const normalized = normalizeBind(input);
    if (normalized === null) return { ok: false, reason: bindFailure(input) };
    const read = this.read();
    if (!read.ok) return read;
    const existing = read.mappings.get(normalized.parentCallSid) ?? null;
    if (existing !== null) {
      return sameBinding(existing, normalized)
        ? { ok: true, mapping: existing }
        : { ok: false, reason: 'mapping_conflict' };
    }
    const mapping: C0Mapping = { ...normalized, terminal: null };
    this.append({ type: 'bind', mapping });
    return { ok: true, mapping };
  }

  get(parentCallSid: string): C0Mapping | null | MappingUnavailable {
    const parent = callSid(parentCallSid);
    if (parent === null) return null;
    const read = this.read();
    if (!read.ok) return read;
    return read.mappings.get(parent) ?? null;
  }

  markTerminal(parentCallSid: string, terminal: C0MappingTerminalState): C0Mapping | null | MappingUnavailable {
    const parent = callSid(parentCallSid);
    if (parent === null || !['ended', 'transferred', 'failed'].includes(terminal)) return null;
    const read = this.read();
    if (!read.ok) return read;
    const existing = read.mappings.get(parent) ?? null;
    if (existing === null) return null;
    if (existing.terminal === terminal) return existing;
    if (existing.terminal !== null) return null;
    this.append({ type: 'terminal', parentCallSid: parent, terminal });
    return { ...existing, terminal };
  }

  snapshot(): C0MappingSnapshot {
    const read = this.read();
    if (!read.ok) throw new Error('mapping_unavailable');
    const mappings = [...read.mappings.values()];
    const terminalCounts: Record<C0MappingTerminalState | 'open', number> = {
      open: 0,
      ended: 0,
      transferred: 0,
      failed: 0,
    };
    for (const mapping of mappings) terminalCounts[mapping.terminal ?? 'open'] += 1;
    return {
      redacted: true,
      path: this.path,
      total: mappings.length,
      terminalCounts,
      mappings: mappings.map((mapping) => ({
        parentCallSid: redactedCallSid(mapping.parentCallSid),
        ...(mapping.childCallSid === undefined ? {} : { childCallSid: redactedCallSid(mapping.childCallSid) }),
        terminal: mapping.terminal,
      })),
    };
  }

  private append(event: MappingEvent): void {
    this.filesystem.mkdirSync(path.dirname(this.path), { recursive: true, mode: 0o700 });
    this.filesystem.appendFileSync(this.path, `${JSON.stringify(event)}\n`, { encoding: 'utf-8', mode: 0o600 });
  }

  private read(): MappingRead {
    let raw: string;
    try {
      raw = this.filesystem.readFileSync(this.path, 'utf-8');
    } catch (error) {
      return isMissingFile(error) ? { ok: true, mappings: new Map() } : unavailable();
    }
    const mappings = new Map<string, C0Mapping>();
    for (const line of raw.split('\n')) {
      if (line.trim() === '') continue;
      try {
        const event = JSON.parse(line) as Partial<MappingEvent>;
        if (event === null || typeof event !== 'object') return unavailable();
        if (event.type === 'bind') {
          if (event.mapping === undefined || event.mapping.terminal !== null) return unavailable();
          const binding = normalizeBind(event.mapping);
          if (binding === null) return unavailable();
          const existing = mappings.get(binding.parentCallSid);
          if (existing === undefined) mappings.set(binding.parentCallSid, { ...binding, terminal: null });
          else if (!sameBinding(existing, binding)) return unavailable();
        } else if (event.type === 'terminal') {
          const parent = callSid(event.parentCallSid);
          const terminal = event.terminal;
          if (parent === null || !isTerminalState(terminal)) return unavailable();
          const existing = mappings.get(parent);
          if (existing === undefined) return unavailable();
          if (existing.terminal === null) mappings.set(parent, { ...existing, terminal });
          else if (existing.terminal !== terminal) return unavailable();
        } else {
          return unavailable();
        }
      } catch {
        return unavailable();
      }
    }
    return { ok: true, mappings };
  }
}
