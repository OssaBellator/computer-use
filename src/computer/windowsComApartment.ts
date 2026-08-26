export type WindowsComApartmentKind = 'mta';

export interface WindowsComApartmentContext {
  readonly apartment:'mta';
  readonly threadToken:string;
}

export interface WindowsComApartmentHost {
  readonly apartment:'mta';
  readonly threadToken:string;
  run<T>(operation:(context:WindowsComApartmentContext)=>Promise<T>):Promise<T>;
  dispose():Promise<void>;
}

const TOKEN_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,127}$/i;

/**
 * Serializes all UI Automation bridge work onto one dedicated MTA owner.
 * Native implementations must initialize COM with COINIT_MULTITHREADED on the
 * backing thread and must not allow UIA interface pointers to escape it.
 */
export class WindowsComApartmentExecutor {
  private tail:Promise<unknown> = Promise.resolve();
  private disposed = false;

  constructor(readonly host:WindowsComApartmentHost) {
    if (host.apartment !== 'mta' || !TOKEN_PATTERN.test(host.threadToken)) {
      throw new Error('windows-com-apartment-invalid');
    }
  }

  run<T>(operation:(context:WindowsComApartmentContext)=>Promise<T>):Promise<T> {
    if (this.disposed) return Promise.reject(new Error('windows-com-apartment-disposed'));
    const execute = async ():Promise<T> => {
      if (this.disposed) throw new Error('windows-com-apartment-disposed');
      return this.host.run(async (context) => {
        if (context.apartment !== 'mta' || context.threadToken !== this.host.threadToken) {
          throw new Error('windows-com-apartment-affinity-violation');
        }
        return operation(Object.freeze({apartment:'mta',threadToken:context.threadToken}));
      });
    };
    const scheduled = this.tail.then(execute,execute);
    this.tail = scheduled.then(()=>undefined,()=>undefined);
    return scheduled;
  }

  async dispose():Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await this.tail;
    await this.host.dispose();
  }
}
