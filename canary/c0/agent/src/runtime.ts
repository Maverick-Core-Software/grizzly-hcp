import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = path.resolve(fileURLToPath(new URL('../../../../', import.meta.url)));

export function resolveDataRoot(value: string | null | undefined): string {
  if (!fs.existsSync(path.join(REPO_ROOT, 'src', 'agent', 'voice'))) {
    throw new Error('c0_repo_root_invalid');
  }
  if (!value) return path.join(REPO_ROOT, 'data', 'c0');
  if (!path.isAbsolute(value)) throw new Error('c0_data_dir_must_be_absolute');
  return path.normalize(value);
}

export function resolveCanaryPath(value: string | null | undefined, fallback: string): string {
  const selected = value?.trim() || fallback;
  return path.isAbsolute(selected) ? path.normalize(selected) : path.resolve(REPO_ROOT, selected);
}

export interface MarkerWriter {
  mark(kind: 'answered' | 'first-audio', callSid: string): void;
}

export class FileMarkerWriter implements MarkerWriter {
  constructor(private readonly dataRoot: string) {}
  mark(kind: 'answered' | 'first-audio', callSid: string): void {
    const target = path.join(this.dataRoot, kind, callSid);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    fs.writeFileSync(target, '', { flag: 'a', mode: 0o600 });
  }
}

export interface DailyUsage { readonly todayCalls: number; readonly todayGptLiveMinutes: number }

function chicagoDate(now: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(now);
}

export class DailyUsageStore {
  constructor(private readonly dataRoot: string, private readonly now: () => Date = () => new Date()) {}
  usage(): DailyUsage | null {
    const file = path.join(this.dataRoot, `usage-${chicagoDate(this.now())}.jsonl`);
    let body: string;
    try {
      body = fs.readFileSync(file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { todayCalls: 0, todayGptLiveMinutes: 0 };
      return null;
    }
    let todayCalls = 0;
    let seconds = 0;
    for (const line of body.split('\n')) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as { calls?: unknown; gptLiveSeconds?: unknown };
        if (!Number.isSafeInteger(entry.calls) || (entry.calls as number) < 0 || typeof entry.gptLiveSeconds !== 'number' || entry.gptLiveSeconds < 0) return null;
        todayCalls += entry.calls as number;
        seconds += entry.gptLiveSeconds;
      } catch { return null; }
    }
    return { todayCalls, todayGptLiveMinutes: seconds / 60 };
  }
  append(calls: number, gptLiveSeconds: number): void {
    if (!Number.isSafeInteger(calls) || calls < 0 || !Number.isFinite(gptLiveSeconds) || gptLiveSeconds < 0) throw new Error('c0_usage_invalid');
    const file = path.join(this.dataRoot, `usage-${chicagoDate(this.now())}.jsonl`);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.appendFileSync(file, `${JSON.stringify({ calls, gptLiveSeconds })}\n`, { encoding: 'utf8', mode: 0o600 });
  }
}
