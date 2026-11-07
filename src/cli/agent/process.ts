import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

export type ServiceName = 'ollama' | 'wallet-service' | 'start' | 'recurring';
export type Readiness = 'offline' | 'waiting' | 'ready';

/** Only fixed, user-facing messages belong here; child errors can contain credentials. */
export class ServiceStartError extends Error {
  constructor(
    readonly service: ServiceName,
    message: string,
  ) {
    super(message);
  }
}

export interface ServiceOptions {
  signal?: AbortSignal;
  startTimeoutMs?: number;
  fetchImpl?: typeof fetch;
  spawnImpl?: typeof spawn;
  onStatus?: (note: string) => void;
}

export interface ServiceHandle {
  started: boolean;
  stop(): void;
  /** Keep a shared service such as Ollama alive after successful startup. */
  detach(): void;
}

export const reusedService = (): ServiceHandle => ({ started: false, stop() {}, detach() {} });

export function checkCancelled(signal?: AbortSignal): void {
  signal?.throwIfAborted();
}

export function requestSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export async function responseObject(response: Response): Promise<Record<string, unknown>> {
  const value: unknown = await response.json().catch(() => undefined);
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** A timeout can mean an occupied but slow port; it must not trigger a second server. */
export async function probeHttp(
  url: string,
  opts: ServiceOptions,
  headers?: Record<string, string>,
): Promise<Response | 'offline' | 'waiting'> {
  checkCancelled(opts.signal);
  try {
    return await (opts.fetchImpl ?? fetch)(url, {
      headers,
      redirect: 'error',
      signal: requestSignal(opts.signal, 2000),
    });
  } catch (error) {
    checkCancelled(opts.signal);
    if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) return 'waiting';
    return 'offline';
  }
}

/** Reuse healthy services. On failure/cancellation, stop only the process started by this invocation. */
export async function ensureProcess(
  spec: {
    service: ServiceName;
    label: string;
    probe: () => Promise<Readiness>;
    command: () => { executable: string; args: string[]; options?: SpawnOptions };
    failure: string;
  },
  opts: ServiceOptions = {},
): Promise<ServiceHandle> {
  checkCancelled(opts.signal);
  let state = await spec.probe();
  checkCancelled(opts.signal);
  if (state === 'ready') return reusedService();
  let child: ChildProcess | undefined;
  let exited = false;
  let stopped = false;
  const handle: ServiceHandle = {
    started: false,
    stop() {
      if (stopped) return;
      stopped = true;
      if (child && !exited && child.exitCode === null) child.kill('SIGTERM');
    },
    detach() {
      child?.unref();
    },
  };
  try {
    if (state === 'offline') {
      const { executable, args, options } = spec.command();
      checkCancelled(opts.signal);
      opts.onStatus?.(`Starting ${spec.label}...`);
      child = (opts.spawnImpl ?? spawn)(executable, args, {
        stdio: 'ignore',
        windowsHide: true,
        ...options,
      });
      handle.started = true;
      child.once('exit', () => {
        exited = true;
      });
      child.once('error', () => {
        exited = true;
      });
    } else opts.onStatus?.(`Waiting for ${spec.label}...`);
    const deadline = Date.now() + (opts.startTimeoutMs ?? 60_000);
    while (true) {
      checkCancelled(opts.signal);
      state = await spec.probe();
      checkCancelled(opts.signal);
      // Another launcher may have won the race to bind the same port.
      if (state === 'ready') return handle;
      if (exited || Date.now() >= deadline) throw new ServiceStartError(spec.service, spec.failure);
      await delay(250, undefined, { signal: opts.signal });
    }
  } catch (error) {
    handle.stop();
    checkCancelled(opts.signal);
    throw error instanceof ServiceStartError ? error : new ServiceStartError(spec.service, spec.failure);
  }
}
