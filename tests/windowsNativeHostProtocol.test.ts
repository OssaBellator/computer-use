import test from 'node:test';
import assert from 'node:assert/strict';
import {
  WindowsNativeHostError,
  WindowsNativeHostProtocolClient,
  WINDOWS_NATIVE_HOST_PROTOCOL_VERSION,
  type WindowsNativeHostRequest,
} from '../src/computer/windowsNativeHostProtocol.js';

function ids(values:string[]=['req-1']) {
  let index=0;
  return {next:()=>values[index++] ?? `req-${index}`};
}

test('native host protocol correlates exact request and bounded ok response', async () => {
  let request:WindowsNativeHostRequest|undefined;
  const client = new WindowsNativeHostProtocolClient({
    maxMessageBytes:64_000,
    exchange:async(value)=>{
      request=value;
      return {protocol:WINDOWS_NATIVE_HOST_PROTOCOL_VERSION,id:value.id,status:'ok',body:{value:7}};
    },
    close:async()=>undefined,
  },ids());
  assert.deepEqual(await client.call('integrity.current',{}),{value:7});
  assert.equal(request?.operation,'integrity.current');
  assert.equal(request?.protocol,1);
});

test('mismatched response id is rejected instead of cross-wiring concurrent authority', async () => {
  const client = new WindowsNativeHostProtocolClient({
    maxMessageBytes:64_000,
    exchange:async()=>({protocol:1,id:'other-request',status:'ok',body:{}}),
    close:async()=>undefined,
  },ids());
  await assert.rejects(()=>client.call('hello',{}),/response-invalid/);
});

test('bounded native error becomes typed host error', async () => {
  const client = new WindowsNativeHostProtocolClient({
    maxMessageBytes:64_000,
    exchange:async(value)=>({protocol:1,id:value.id,status:'error',error:'uia.element-missing'}),
    close:async()=>undefined,
  },ids());
  await assert.rejects(async()=>{
    try {
      await client.call('uia.resolve-control',{});
    } catch (error) {
      assert.ok(error instanceof WindowsNativeHostError);
      assert.equal(error.code,'uia.element-missing');
      throw error;
    }
  },/uia\.element-missing/);
});

test('response accessor is rejected without invoking getter', async () => {
  let getterCalls=0;
  const client = new WindowsNativeHostProtocolClient({
    maxMessageBytes:64_000,
    exchange:async(value)=>{
      const response:{protocol:number;id:string;status?:string}={protocol:1,id:value.id};
      Object.defineProperty(response,'status',{enumerable:true,get(){getterCalls+=1;return 'ok';}});
      return response;
    },
    close:async()=>undefined,
  },ids());
  await assert.rejects(()=>client.call('hello',{}),/response-invalid/);
  assert.equal(getterCalls,0);
});

test('closed protocol client cannot issue more native authority requests', async () => {
  let closes=0;
  const client = new WindowsNativeHostProtocolClient({
    maxMessageBytes:64_000,
    exchange:async(value)=>({protocol:1,id:value.id,status:'ok',body:{}}),
    close:async()=>{closes+=1;},
  },ids());
  await client.close();
  await client.close();
  assert.equal(closes,1);
  await assert.rejects(()=>client.call('hello',{}),/native-host-closed/);
});

test('protocol rejects unsafe transport message bound and invalid request ids', async () => {
  assert.throws(()=>new WindowsNativeHostProtocolClient({
    maxMessageBytes:2_000_000,exchange:async()=>({}),close:async()=>undefined,
  },ids()),/message-bound-invalid/);

  const client = new WindowsNativeHostProtocolClient({
    maxMessageBytes:64_000,exchange:async()=>({}),close:async()=>undefined,
  },ids(['bad id with spaces']));
  await assert.rejects(()=>client.call('hello',{}),/request-id-invalid/);
});
