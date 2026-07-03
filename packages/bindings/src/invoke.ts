import type { GraphiteError, GraphiteErrorCode } from './types';

const ERROR_CODES: readonly GraphiteErrorCode[] = [
  'NOT_FOUND',
  'CONFLICT',
  'VALIDATION',
  'AMBIGUOUS',
  'LIMIT',
  'FORBIDDEN',
  'UNAVAILABLE',
];

type InvokeArgs = Record<string, unknown>;
type InvokeFn = (command: string, args?: InvokeArgs) => Promise<unknown>;

function resolveTauriInvoke(): InvokeFn | undefined {
  if (typeof window === 'undefined') {
    return undefined;
  }
  const internals = (window as Window & { __TAURI_INTERNALS__?: { invoke?: unknown } }).__TAURI_INTERNALS__;
  if (internals === undefined || typeof internals.invoke !== 'function') {
    return undefined;
  }
  return (internals.invoke as InvokeFn).bind(internals);
}

export function isTauriAvailable(): boolean {
  return resolveTauriInvoke() !== undefined;
}

export function isGraphiteError(value: unknown): value is GraphiteError {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as { code?: unknown; message?: unknown };
  return (
    typeof candidate.code === 'string' &&
    (ERROR_CODES as readonly string[]).includes(candidate.code) &&
    typeof candidate.message === 'string'
  );
}

export function unavailableError(command: string): GraphiteError {
  return {
    code: 'UNAVAILABLE',
    message: `Tauri runtime is not available: command "${command}" requires the Graphite shell`,
    hint: 'run inside the Graphite desktop app',
  };
}

export function invoke<T>(command: string, args?: InvokeArgs): Promise<T> {
  const tauriInvoke = resolveTauriInvoke();
  if (tauriInvoke === undefined) {
    return Promise.reject(unavailableError(command));
  }
  return tauriInvoke(command, args) as Promise<T>;
}
