/**
 * User preferences persisted in localStorage, exposed as a tiny external store
 * (consumed with useSyncExternalStore so server and client renders agree).
 */

export interface Preferences {
  /** 0..1 */
  volume: number;
  muted: boolean;
  /** Enter fullscreen when the fire is lit (when the browser allows it). */
  fullscreen: boolean;
  /** Keep the control bar completely hidden. */
  controlsHidden: boolean;
}

export const DEFAULT_PREFERENCES: Preferences = Object.freeze({
  volume: 0.7,
  muted: false,
  fullscreen: true,
  controlsHidden: false,
});

const STORAGE_KEY = "fireplace:preferences";
const WRITE_DELAY = 250;

let cache: Preferences | null = null;
let writeTimer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();

function sanitize(value: unknown): Preferences {
  const v = (value && typeof value === "object" ? value : {}) as Partial<Record<keyof Preferences, unknown>>;
  const volume = typeof v.volume === "number" && Number.isFinite(v.volume) ? Math.min(1, Math.max(0, v.volume)) : DEFAULT_PREFERENCES.volume;
  return {
    volume,
    muted: typeof v.muted === "boolean" ? v.muted : DEFAULT_PREFERENCES.muted,
    fullscreen: typeof v.fullscreen === "boolean" ? v.fullscreen : DEFAULT_PREFERENCES.fullscreen,
    controlsHidden: typeof v.controlsHidden === "boolean" ? v.controlsHidden : DEFAULT_PREFERENCES.controlsHidden,
  };
}

function read(): Preferences {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? sanitize(JSON.parse(raw)) : { ...DEFAULT_PREFERENCES };
  } catch {
    return { ...DEFAULT_PREFERENCES };
  }
}

function write(): void {
  writeTimer = null;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(cache));
  } catch {
    /* storage unavailable (private mode, quota...) */
  }
}

function flush(): void {
  if (writeTimer !== null) {
    clearTimeout(writeTimer);
    write();
  }
}

function emit(): void {
  for (const listener of listeners) listener();
}

function onStorage(event: StorageEvent): void {
  if (event.key !== STORAGE_KEY) return;
  cache = read();
  emit();
}

export function getPreferences(): Preferences {
  if (cache === null) cache = read();
  return cache;
}

export function getServerPreferences(): Preferences {
  return DEFAULT_PREFERENCES;
}

export function subscribePreferences(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) {
    window.addEventListener("storage", onStorage);
    window.addEventListener("pagehide", flush);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("pagehide", flush);
    }
  };
}

export function updatePreferences(patch: Partial<Preferences>): void {
  const next = sanitize({ ...getPreferences(), ...patch });
  const current = getPreferences();
  if (
    next.volume === current.volume &&
    next.muted === current.muted &&
    next.fullscreen === current.fullscreen &&
    next.controlsHidden === current.controlsHidden
  ) {
    return;
  }
  cache = next;
  if (writeTimer !== null) clearTimeout(writeTimer);
  writeTimer = setTimeout(write, WRITE_DELAY);
  emit();
}
