/** Collision-resistant local ids. No network or crypto dependency required. */
export function createId(prefix: string): string {
  const cryptoObj = globalThis.crypto as Crypto | undefined;
  if (cryptoObj?.randomUUID) {
    return `${prefix}-${cryptoObj.randomUUID()}`;
  }
  const random = Math.random().toString(36).slice(2, 10);
  return `${prefix}-${Date.now().toString(36)}-${random}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** Monotonic turn/session id helper used by the event sequencer. */
export function createSessionId(): string {
  return createId('session');
}

export function createTurnId(): string {
  return createId('turn');
}
