import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { TextDecoder, TextEncoder } from 'node:util';
import type { WindowsNativeHostRequest, WindowsNativeHostTransport } from './windowsNativeHostProtocol.js';

const MAX_MESSAGE_BYTES=1_048_576;
const MAX_PATH_BYTES=32_768;
const encoder=new TextEncoder();

interface PendingExchange {
  readonly resolve:(value:unknown)=>void;
  readonly reject:(error:Error)=>void;
}

function validExecutablePath(value:string):boolean {
  return value.length>0&&!value.includes('\0')&&encoder.encode(value).byteLength<=MAX_PATH_BYTES;
}

/**
 * Length-bounded JSONL transport for the dedicated Windows native host.
 * The child is spawned directly with shell:false; stdout is protocol-only and
 * stderr is drained separately so diagnostic text can never become authority data.
 */
export class WindowsNativeHostStdioTransport implements WindowsNativeHostTransport {
  readonly maxMessageBytes:number;
  private readonly child:ChildProcessWithoutNullStreams;
  private readonly decoder=new TextDecoder('utf-8',{fatal:true});
  private readonly pending:PendingExchange[]=[];
  private text='';
  private bufferedBytes=0;
  private closed=false;
  private terminalError:Error|undefined;

  private constructor(child:ChildProcessWithoutNullStreams,maxMessageBytes:number){
    this.child=child;
    this.maxMessageBytes=maxMessageBytes;
    child.stdout.on('data',(chunk:Uint8Array)=>this.onStdout(chunk));
    child.stderr.on('data',()=>undefined);
    child.once('error',(error)=>this.fail(new Error(`windows-native-host-process-error:${error.message}`)));
    child.once('close',(code,signal)=>this.fail(new Error(`windows-native-host-process-closed:${code ?? 'null'}:${signal ?? 'none'}`)));
  }

  static spawn(executablePath:string,options?:{readonly maxMessageBytes?:number;readonly cwd?:string}):WindowsNativeHostStdioTransport {
    if(process.platform!=='win32')throw new Error('windows-native-host-requires-win32');
    if(!validExecutablePath(executablePath))throw new Error('windows-native-host-path-invalid');
    if(options?.cwd!==undefined&&!validExecutablePath(options.cwd))throw new Error('windows-native-host-cwd-invalid');
    const maxMessageBytes=options?.maxMessageBytes??1_048_576;
    if(!Number.isSafeInteger(maxMessageBytes)||maxMessageBytes<1||maxMessageBytes>MAX_MESSAGE_BYTES){
      throw new Error('windows-native-host-message-bound-invalid');
    }
    const child=spawn(executablePath,[],{
      cwd:options?.cwd,
      shell:false,
      windowsHide:true,
      stdio:['pipe','pipe','pipe'],
    });
    return new WindowsNativeHostStdioTransport(child,maxMessageBytes);
  }

  exchange(request:WindowsNativeHostRequest):Promise<unknown>{
    if(this.closed) return Promise.reject(this.terminalError??new Error('windows-native-host-transport-closed'));
    let line:string;
    try{line=JSON.stringify(request);}catch{return Promise.reject(new Error('windows-native-host-request-serialization-failed'));}
    const bytes=encoder.encode(line).byteLength+1;
    if(bytes>this.maxMessageBytes)return Promise.reject(new Error('windows-native-host-request-too-large'));

    return new Promise<unknown>((resolve,reject)=>{
      if(this.closed){reject(this.terminalError??new Error('windows-native-host-transport-closed'));return;}
      this.pending.push({resolve,reject});
      this.child.stdin.write(`${line}\n`,'utf8',(error)=>{
        if(error)this.fail(new Error(`windows-native-host-write-failed:${error.message}`));
      });
    });
  }

  async close():Promise<void>{
    if(this.closed)return;
    this.closed=true;
    this.child.stdin.end();
    this.rejectPending(new Error('windows-native-host-transport-closed'));
    if(this.child.exitCode!==null)return;
    await new Promise<void>((resolve)=>{
      let settled=false;
      const finish=()=>{if(settled)return;settled=true;clearTimeout(timer);resolve();};
      const timer=setTimeout(()=>{if(this.child.exitCode===null)this.child.kill();finish();},1_000);
      this.child.once('close',finish);
    });
  }

  private onStdout(chunk:Uint8Array):void{
    if(this.closed)return;
    try{
      this.bufferedBytes+=chunk.byteLength;
      if(this.bufferedBytes>this.maxMessageBytes){this.fail(new Error('windows-native-host-response-too-large'));return;}
      this.text+=this.decoder.decode(chunk,{stream:true});
      while(true){
        const index=this.text.indexOf('\n');
        if(index<0)break;
        const line=this.text.slice(0,index).replace(/\r$/,'');
        this.text=this.text.slice(index+1);
        this.bufferedBytes=encoder.encode(this.text).byteLength;
        if(line.length===0){this.fail(new Error('windows-native-host-empty-response'));return;}
        const pending=this.pending.shift();
        if(!pending){this.fail(new Error('windows-native-host-unsolicited-response'));return;}
        try{pending.resolve(JSON.parse(line));}
        catch{pending.reject(new Error('windows-native-host-response-json-invalid'));}
      }
    }catch{
      this.fail(new Error('windows-native-host-response-utf8-invalid'));
    }
  }

  private fail(error:Error):void{
    if(this.terminalError)return;
    this.terminalError=error;
    this.closed=true;
    this.rejectPending(error);
    if(this.child.exitCode===null)this.child.kill();
  }

  private rejectPending(error:Error):void{
    while(this.pending.length>0)this.pending.shift()!.reject(error);
  }
}
