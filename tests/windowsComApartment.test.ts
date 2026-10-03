import test from 'node:test';
import assert from 'node:assert/strict';
import { WindowsComApartmentExecutor } from '../src/computer/windowsComApartment.js';

function host() {
  let disposed = false;
  return {
    apartment:'mta' as const,
    threadToken:'uia-mta-1',
    run:async <T>(operation:(context:{apartment:'mta';threadToken:string})=>Promise<T>) => {
      if (disposed) throw new Error('disposed');
      return operation({apartment:'mta',threadToken:'uia-mta-1'});
    },
    dispose:async()=>{disposed=true;},
  };
}

test('UIA apartment serializes work onto one MTA owner', async () => {
  const executor = new WindowsComApartmentExecutor(host());
  const order:number[] = [];
  await Promise.all([
    executor.run(async()=>{order.push(1); await Promise.resolve(); order.push(2);}),
    executor.run(async()=>{order.push(3);}),
  ]);
  assert.deepEqual(order,[1,2,3]);
  await executor.dispose();
});

test('UIA apartment rejects thread-affinity drift', async () => {
  const badHost = {
    apartment:'mta' as const,
    threadToken:'uia-mta-1',
    run:async <T>(operation:(context:{apartment:'mta';threadToken:string})=>Promise<T>) => operation({apartment:'mta',threadToken:'other-thread'}),
    dispose:async()=>{},
  };
  const executor = new WindowsComApartmentExecutor(badHost);
  await assert.rejects(executor.run(async()=>42),/affinity-violation/);
});

test('disposed UIA apartment refuses new operations', async () => {
  const executor = new WindowsComApartmentExecutor(host());
  await executor.dispose();
  await assert.rejects(executor.run(async()=>1),/disposed/);
});
