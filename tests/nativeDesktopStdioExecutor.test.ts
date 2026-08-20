import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  StdioDesktopBridgeExecutor,
  snapshotNativeDesktopStdioCommand,
  type NativeDesktopStdioCommand,
} from '../src/computer/nativeDesktopStdioExecutor.js';

const helper = join(process.cwd(), 'tests/fixtures/nativeDesktopStdioHelper.mjs');

function executor(args:string[] = [],overrides:{maxRequestBytes?:number;maxResponseBytes?:number;timeoutMs?:number} = {}) {
  return new StdioDesktopBridgeExecutor({
    executable:process.execPath,
    args:[helper,...args],
    maxRequestBytes:overrides.maxRequestBytes,
    maxResponseBytes:overrides.maxResponseBytes,
    timeoutMs:overrides.timeoutMs,
  });
}

test('stdio transport keeps desktop action payload out of helper argv',async()=>{
  const transport = executor();
  const secretText = 'typed-value-not-for-process-list';
  const result = await transport.invoke('dispatch',{
    action:{kind:'keyboard',input:{kind:'text',text:secretText}},
  },{maxResponseBytes:32_768,timeoutMs:2_000}) as {
    operation:string;
    payload:{action:{input:{text:string}}};
    argv:string[];
  };
  assert.equal(result.operation,'dispatch');
  assert.equal(result.payload.action.input.text,secretText);
  assert.equal(result.argv.some((arg)=>arg.includes(secretText)),false);
});

test('stdio transport rejects oversized request before spawning helper',async()=>{
  const transport = new StdioDesktopBridgeExecutor({executable:'/definitely/not/a/helper',maxRequestBytes:64});
  await assert.rejects(
    ()=>transport.invoke('dispatch',{text:'x'.repeat(512)},{maxResponseBytes:1_024,timeoutMs:1_000}),
    /request too large/,
  );
});

test('stdio transport kills and rejects helper output beyond response budget',async()=>{
  const transport = executor(['--oversize'],{maxResponseBytes:512});
  await assert.rejects(
    ()=>transport.invoke('enumerate-windows',{}, {maxResponseBytes:512,timeoutMs:2_000}),
    /response too large/,
  );
});

test('stdio transport waits for helper termination acknowledgement before timeout rejection',async()=>{
  const directory = mkdtempSync(join(tmpdir(),'desktop-helper-'));
  const pidFile = join(directory,'pid');
  try {
    const transport = executor(['--hang',`--pid-file=${pidFile}`],{timeoutMs:100});
    await assert.rejects(
      ()=>transport.invoke('dispatch',{action:{kind:'keyboard',input:{kind:'key-down',key:'A'}}},{maxResponseBytes:1_024,timeoutMs:100}),
      /timed out/,
    );
    const pid = Number(readFileSync(pidFile,'utf8'));
    assert.equal(Number.isSafeInteger(pid),true);
    assert.throws(()=>process.kill(pid,0));
  } finally {
    rmSync(directory,{recursive:true,force:true});
  }
});

test('stdio transport does not expose helper stderr in rejection text',async()=>{
  const transport = executor(['--emit-stderr','--fail']);
  await assert.rejects(
    async()=>{
      try { await transport.invoke('dispatch',{}, {maxResponseBytes:1_024,timeoutMs:2_000}); }
      catch (error) {
        assert.equal(String(error).includes('secret-looking'),false);
        throw error;
      }
    },
    /exited unsuccessfully/,
  );
});

test('stdio executor snapshots helper command authority at construction',async()=>{
  const args = [helper];
  const command = {executable:process.execPath,args};
  const transport = new StdioDesktopBridgeExecutor(command);
  args.push('--fail');
  command.executable = '/definitely/not/the-original-runtime';
  const result = await transport.invoke('enumerate-windows',{limits:{maxItems:1}},{maxResponseBytes:4_096,timeoutMs:2_000}) as {operation:string};
  assert.equal(result.operation,'enumerate-windows');
});

test('stdio command rejects top-level accessors without invoking getters',()=>{
  let getterCalls = 0;
  const command:Record<string,unknown> = {};
  Object.defineProperty(command,'executable',{enumerable:true,get(){ getterCalls += 1; return process.execPath; }});
  assert.throws(()=>new StdioDesktopBridgeExecutor(command as unknown as NativeDesktopStdioCommand),/command accessor rejected/);
  assert.equal(getterCalls,0);
});

test('stdio command rejects argv element accessors without invoking them',()=>{
  let getterCalls = 0;
  const args:unknown[] = [];
  Object.defineProperty(args,'0',{enumerable:true,get(){ getterCalls += 1; return helper; }});
  Object.defineProperty(args,'length',{value:1,writable:true,configurable:false});
  assert.throws(()=>new StdioDesktopBridgeExecutor({executable:process.execPath,args:args as string[]}),/arguments invalid/);
  assert.equal(getterCalls,0);
});

test('stdio command does not enumerate legacy object environment keys',()=>{
  let ownKeysCalls = 0;
  const env = new Proxy({SECRET:'value'},{ownKeys(){ ownKeysCalls += 1; throw new Error('ownKeys must not run'); }});
  const command = {executable:process.execPath,env} as unknown as NativeDesktopStdioCommand;
  assert.throws(()=>new StdioDesktopBridgeExecutor(command),/object environment unsupported/);
  assert.equal(ownKeysCalls,0);
});

test('stdio command captures bounded explicit environment entries without caller-owned key enumeration',()=>{
  let ownKeysCalls = 0;
  const entry = new Proxy({name:'DESKTOP_HELPER_MODE',value:'test'},{ownKeys(){ ownKeysCalls += 1; throw new Error('ownKeys must not run'); }});
  const entries = new Proxy([entry],{ownKeys(){ ownKeysCalls += 1; throw new Error('ownKeys must not run'); }});
  const snapshot = snapshotNativeDesktopStdioCommand({executable:process.execPath,envEntries:entries});
  assert.equal(snapshot.environment?.DESKTOP_HELPER_MODE,'test');
  assert.equal(ownKeysCalls,0);
});

test('stdio command environment entry accessors are rejected without invocation',()=>{
  let getterCalls = 0;
  const entry:Record<string,unknown> = {value:'test'};
  Object.defineProperty(entry,'name',{enumerable:true,get(){ getterCalls += 1; return 'DESKTOP_HELPER_MODE'; }});
  assert.throws(()=>snapshotNativeDesktopStdioCommand({executable:process.execPath,envEntries:[entry as unknown as {name:string;value:string}]}),/command accessor rejected/);
  assert.equal(getterCalls,0);
});
