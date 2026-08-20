import { writeFileSync } from 'node:fs';

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  const request = JSON.parse(input);
  const pidArg = process.argv.find((arg) => arg.startsWith('--pid-file='));
  if (pidArg) writeFileSync(pidArg.slice('--pid-file='.length), String(process.pid));
  if (process.argv.includes('--emit-stderr')) process.stderr.write('secret-looking helper diagnostic must not escape\n');
  if (process.argv.includes('--hang')) {
    setInterval(() => {}, 10_000);
    return;
  }
  if (process.argv.includes('--oversize')) {
    process.stdout.write(JSON.stringify({ value: 'x'.repeat(16_384) }));
    return;
  }
  if (process.argv.includes('--fail')) {
    process.exitCode = 7;
    return;
  }
  process.stdout.write(JSON.stringify({
    version: request.version,
    operation: request.operation,
    payload: request.payload,
    argv: process.argv.slice(2),
  }));
});
