type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export function echo(input: Json): string { return JSON.stringify(input); }
export function largeOutput(): string { return JSON.stringify('x'.repeat(16 * 1024)); }
export function busyForever(): string { for (;;) { /* intentionally unresponsive isolated work */ } }
export async function neverSettles(): Promise<string> { return await new Promise<string>(() => {}); }
export function crash(): string { process.exit(23); }
export function artifact(input: Json): string { return JSON.stringify({ kind: 'artifact', input }); }
export async function delayedEcho(input: Json): Promise<string> {
  if (input === 'slow') await new Promise((resolve) => setTimeout(resolve, 60));
  return JSON.stringify(input);
}
export function frozenInput(input: Json): string {
  if (!input || typeof input !== 'object' || !Object.isFrozen(input)) throw new Error('input-not-frozen');
  return JSON.stringify(input);
}
