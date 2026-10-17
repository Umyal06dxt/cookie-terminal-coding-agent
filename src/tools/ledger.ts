import { statSync } from 'node:fs';
import type { ReadLedger, ToolResult } from './types.ts';

/**
 * Refuses a change to a file the model hasn't read, or whose contents moved under it.
 * Returns null when it is safe to go ahead.
 */
export function checkFresh(
  ledger: ReadLedger,
  abs: string,
  rel: string,
  options: { needFull: boolean; action: string; fullReadHint?: string },
): ToolResult | null {
  const entry = ledger.get(abs);
  if (!entry) {
    return {
      ok: false,
      output: `You haven't read ${rel} yet, so it can't be ${options.action}.`,
      hint: `Read ${rel} first, then try again.`,
    };
  }
  const stat = statSync(abs);
  if (stat.mtimeMs !== entry.mtimeMs || stat.size !== entry.size) {
    return {
      ok: false,
      output: 'File changed on disk since you read it; read it again.',
      hint: `Read ${rel} again to see the current contents, then redo the change.`,
    };
  }
  if (options.needFull && !entry.full) {
    return {
      ok: false,
      output: `You have only read part of ${rel}, so it can't be ${options.action}.`,
      hint: options.fullReadHint ?? `Read all of ${rel} first, then try again.`,
    };
  }
  return null;
}

/** After Cookie itself changes a file, the model's view of it is current again. */
export function recordWrite(
  ledger: ReadLedger,
  abs: string,
  full: boolean,
): void {
  const stat = statSync(abs);
  ledger.set(abs, { mtimeMs: stat.mtimeMs, size: stat.size, full });
}
