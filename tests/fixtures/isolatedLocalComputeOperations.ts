type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export function echo(input: Json): Json { return input; }
export function largeOutput(): Json { return 'x'.repeat(16 * 1024); }
export function busyForever(): Json { for (;;) { /* intentionally unresponsive isolated work */ } }
export async function neverSettles(): Promise<Json> { return await new Promise<Json>(() => {}); }
export function crash(): Json { process.exit(23); }
export function artifact(input: Json): Json { return { kind: 'artifact', input }; }
export async function delayedEcho(input: Json): Promise<Json> {
  if (input === 'slow') await new Promise((resolve) => setTimeout(resolve, 60));
  return input;
}
export function frozenInput(input: Json): Json {
  if (!input || typeof input !== 'object' || !Object.isFrozen(input)) throw new Error('input-not-frozen');
  return input;
}
export function symbolOutput(): Json {
  const output: Record<PropertyKey, unknown> = { visible: true };
  output[Symbol('hidden')] = 'must-not-be-silently-dropped';
  return output as Json;
}
