import { spawn, type ChildProcess } from 'node:child_process';
import { access, constants, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import {
  CdpTargetSessionRouter,
  type RoutedCdpSession,
} from '../browser/cdpSessionRouter.js';
import {
  CdpPipeConnection,
  type CdpPipeConnectionOptions,
} from './cdpPipeConnection.js';

export interface StandaloneChromiumLaunchOptions {
  /** Explicit Chromium/Chrome executable. Otherwise common paths and CHROMIUM_BIN/CHROME_BIN are tried. */
  executablePath?: string;
  /** Existing profile directory. A disposable temporary profile is created when omitted. */
  userDataDir?: string;
  /** Keep a temporary profile after shutdown/failure for debugging. */
  preserveUserDataDir?: boolean;
  /** Initial browser target. Defaults to about:blank. */
  initialUrl?: string;
  /** Defaults to true and uses Chromium's current `--headless=new` mode. */
  headless?: boolean;
  /** Explicit opt-in for environments such as local containers that cannot use Chromium's sandbox. */
  noSandbox?: boolean;
  /** Extra Chromium switches. Debugging transport/profile switches are rejected. */
  args?: readonly string[];
  env?: NodeJS.ProcessEnv;
  startupTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  pipe?: CdpPipeConnectionOptions;
}

export interface StandaloneChromiumVersion {
  protocolVersion?: string;
  product?: string;
  revision?: string;
  userAgent?: string;
  jsVersion?: string;
}

export interface StandaloneChromiumTarget {
  targetId: string;
  type: string;
  attached: boolean;
  openerId?: string;
}

export interface StandaloneChromiumPage {
  targetId: string;
  session: RoutedCdpSession;
}

const COMMON_EXECUTABLES: readonly string[] = process.platform === 'darwin'
  ? [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ]
  : process.platform === 'win32'
    ? [
        ...(process.env.PROGRAMFILES
          ? [join(process.env.PROGRAMFILES, 'Google/Chrome/Application/chrome.exe')]
          : []),
        ...(process.env['PROGRAMFILES(X86)']
          ? [join(process.env['PROGRAMFILES(X86)'], 'Google/Chrome/Application/chrome.exe')]
          : []),
        ...(process.env.LOCALAPPDATA
          ? [join(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe')]
          : []),
      ]
    : [
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser',
        '/usr/bin/google-chrome',
        '/usr/bin/google-chrome-stable',
      ];

function nonNegativeInteger(name: string, value: number): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return value;
}

function validateAdditionalArgs(args: readonly string[]): void {
  for (const arg of args) {
    if (arg === '--remote-debugging-pipe' || arg.startsWith('--remote-debugging-port')) {
      throw new Error(
        'remote debugging transport flags are managed by StandaloneChromium',
      );
    }
    if (arg.startsWith('--user-data-dir')) {
      throw new Error('user data directory must be configured through userDataDir');
    }
  }
}

async function executable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function resolveChromiumExecutable(explicitPath?: string): Promise<string> {
  const envCandidates = [
    process.env.CHROMIUM_BIN,
    process.env.CHROME_BIN,
    process.env.GOOGLE_CHROME_BIN,
  ].filter((value): value is string => typeof value === 'string' && value.length > 0);
  const candidates = explicitPath
    ? [explicitPath]
    : [...envCandidates, ...COMMON_EXECUTABLES];

  for (const candidate of candidates) {
    if (await executable(candidate)) return candidate;
  }
  if (explicitPath) {
    throw new Error(`Chromium executable is not accessible: ${explicitPath}`);
  }
  throw new Error(
    `No Chromium executable found; checked ${candidates.join(', ') || 'no configured paths'}`,
  );
}

async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  if (timeoutMs === 0) return false;
  return new Promise<boolean>((resolve) => {
    let timer: NodeJS.Timeout | undefined;
    const onExit = () => {
      if (timer) clearTimeout(timer);
      resolve(true);
    };
    child.once('exit', onExit);
    timer = setTimeout(() => {
      child.off('exit', onExit);
      resolve(false);
    }, timeoutMs);
    timer.unref?.();
  });
}

async function cleanupDirectory(path: string): Promise<void> {
  await rm(path, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 50,
  });
}

/**
 * Direct Chromium process/runtime with no Playwright, Puppeteer, WebDriver, or
 * websocket-client dependency. Browser-root CDP is carried over fd 3/4 through
 * Chromium's `--remote-debugging-pipe` transport.
 */
export class StandaloneChromium {
  readonly router: CdpTargetSessionRouter;
  private shuttingDown?: Promise<void>;

  constructor(
    readonly process: ChildProcess,
    readonly connection: CdpPipeConnection,
    readonly executablePath: string,
    readonly userDataDir: string,
    readonly ownsUserDataDir: boolean,
    readonly version: StandaloneChromiumVersion,
    private readonly shutdownTimeoutMs: number,
    private readonly preserveUserDataDir: boolean,
  ) {
    this.router = new CdpTargetSessionRouter(connection);
  }

  async targets(): Promise<StandaloneChromiumTarget[]> {
    const result = await this.connection.send('Target.getTargets') as {
      targetInfos?: Array<{
        targetId?: string;
        type?: string;
        attached?: boolean;
        openerId?: string;
      }>;
    };
    return (result.targetInfos ?? [])
      .filter((target): target is {
        targetId: string;
        type: string;
        attached?: boolean;
        openerId?: string;
      } => typeof target.targetId === 'string' && typeof target.type === 'string')
      .map((target) => ({
        targetId: target.targetId,
        type: target.type,
        attached: target.attached === true,
        ...(typeof target.openerId === 'string' ? { openerId: target.openerId } : {}),
      }));
  }

  async attachFirstPage(createIfMissing = true): Promise<StandaloneChromiumPage> {
    const pages = (await this.targets()).filter((target) => target.type === 'page');
    if (!pages.length) {
      if (!createIfMissing) throw new Error('Chromium has no page target');
      return this.createPage('about:blank');
    }
    const targetId = pages[0].targetId;
    const session = await this.router.attach(targetId);
    await this.router.activate(targetId);
    return { targetId, session };
  }

  async createPage(url = 'about:blank'): Promise<StandaloneChromiumPage> {
    if (!url) throw new Error('page URL must be non-empty');
    const result = await this.connection.send('Target.createTarget', { url }) as {
      targetId?: string;
    };
    if (typeof result.targetId !== 'string' || !result.targetId) {
      throw new Error('Target.createTarget did not return targetId');
    }
    const session = await this.router.attach(result.targetId);
    await this.router.activate(result.targetId);
    return { targetId: result.targetId, session };
  }

  async closePage(targetId: string): Promise<boolean> {
    if (!targetId) throw new Error('targetId is required');
    const session = this.router.sessionFor(targetId);
    if (session) await this.router.detach(session).catch(() => {});
    const result = await this.connection.send('Target.closeTarget', { targetId }) as {
      success?: boolean;
    };
    return result.success !== false;
  }

  shutdown(): Promise<void> {
    if (this.shuttingDown) return this.shuttingDown;
    this.shuttingDown = this.shutdownInternal();
    return this.shuttingDown;
  }

  private async shutdownInternal(): Promise<void> {
    this.router.dispose();
    if (
      !this.connection.closed &&
      this.process.exitCode === null &&
      this.process.signalCode === null
    ) {
      await this.connection.send('Browser.close').catch(() => {});
    }
    let exited = await waitForExit(this.process, this.shutdownTimeoutMs);
    if (
      !exited &&
      this.process.exitCode === null &&
      this.process.signalCode === null
    ) {
      this.process.kill('SIGKILL');
      exited = await waitForExit(
        this.process,
        Math.max(1000, this.shutdownTimeoutMs),
      );
    }
    this.connection.close(new Error('Standalone Chromium shut down'));
    if (this.ownsUserDataDir && !this.preserveUserDataDir) {
      await cleanupDirectory(this.userDataDir);
    }
    if (
      !exited &&
      this.process.exitCode === null &&
      this.process.signalCode === null
    ) {
      throw new Error('Chromium did not exit after SIGKILL');
    }
  }
}

export async function launchStandaloneChromium(
  options: StandaloneChromiumLaunchOptions = {},
): Promise<StandaloneChromium> {
  const executablePath = await resolveChromiumExecutable(options.executablePath);
  const extraArgs = [...(options.args ?? [])];
  validateAdditionalArgs(extraArgs);
  const startupTimeoutMs = nonNegativeInteger(
    'startupTimeoutMs',
    options.startupTimeoutMs ?? 10_000,
  );
  const shutdownTimeoutMs = nonNegativeInteger(
    'shutdownTimeoutMs',
    options.shutdownTimeoutMs ?? 3_000,
  );
  const initialUrl = options.initialUrl ?? 'about:blank';
  if (!initialUrl || initialUrl.startsWith('-')) {
    throw new Error('initialUrl must be a non-empty browser URL');
  }

  const ownsUserDataDir = options.userDataDir === undefined;
  const userDataDir = options.userDataDir ??
    await mkdtemp(join(tmpdir(), 'standalone-chromium-'));
  if (!ownsUserDataDir) await mkdir(userDataDir, { recursive: true });

  const args = [
    '--remote-debugging-pipe',
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    ...(options.headless === false ? [] : ['--headless=new']),
    ...(options.noSandbox === true ? ['--no-sandbox'] : []),
    ...extraArgs,
    initialUrl,
  ];

  const child = spawn(executablePath, args, {
    stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'],
    env: options.env ?? process.env,
  });
  const writable = child.stdio[3] as Writable | null;
  const readable = child.stdio[4] as Readable | null;
  if (!writable || !readable) {
    child.kill('SIGKILL');
    if (ownsUserDataDir && !options.preserveUserDataDir) {
      await cleanupDirectory(userDataDir);
    }
    throw new Error('Chromium remote-debugging pipe descriptors were not created');
  }

  let stderrTail = '';
  const onStderr = (chunk: Buffer | string) => {
    stderrTail += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk;
    if (stderrTail.length > 16_384) stderrTail = stderrTail.slice(-16_384);
  };
  child.stderr?.on('data', onStderr);

  const connection = new CdpPipeConnection(readable, writable, options.pipe);
  let startupTimer: NodeJS.Timeout | undefined;
  let rejectEarly!: (reason: unknown) => void;
  const earlyFailure = new Promise<never>((_, reject) => {
    rejectEarly = reject;
  });
  const onChildError = (error: Error) => rejectEarly(error);
  const onChildExit = (code: number | null, signal: NodeJS.Signals | null) => {
    rejectEarly(
      new Error(
        `Chromium exited during startup (code=${String(code)}, signal=${String(signal)})${
          stderrTail ? `: ${stderrTail.trim()}` : ''
        }`,
      ),
    );
  };
  child.once('error', onChildError);
  child.once('exit', onChildExit);

  const timeout = new Promise<never>((_, reject) => {
    if (startupTimeoutMs === 0) return;
    startupTimer = setTimeout(
      () => reject(new Error(`Chromium startup timed out after ${startupTimeoutMs}ms`)),
      startupTimeoutMs,
    );
    startupTimer.unref?.();
  });

  try {
    const version = await Promise.race([
      connection.send('Browser.getVersion') as Promise<StandaloneChromiumVersion>,
      earlyFailure,
      timeout,
    ]);
    if (startupTimer) clearTimeout(startupTimer);
    child.off('error', onChildError);
    child.off('exit', onChildExit);
    return new StandaloneChromium(
      child,
      connection,
      executablePath,
      userDataDir,
      ownsUserDataDir,
      version,
      shutdownTimeoutMs,
      options.preserveUserDataDir === true,
    );
  } catch (error) {
    if (startupTimer) clearTimeout(startupTimer);
    child.off('error', onChildError);
    child.off('exit', onChildExit);
    connection.close(error instanceof Error ? error : new Error(String(error)));
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await waitForExit(child, 1000);
    if (ownsUserDataDir && !options.preserveUserDataDir) {
      await cleanupDirectory(userDataDir);
    }
    throw error;
  }
}
