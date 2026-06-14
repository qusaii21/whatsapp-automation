/**
 * Next.js Instrumentation Hook
 * https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation
 *
 * Node v22+ exposes `localStorage` as a partial global (for the Web Storage API).
 * When `--localstorage-file` is not configured, the object exists but methods like
 * `getItem` are missing. Supabase's auth module detects `typeof localStorage === 'object'`
 * and treats it as a browser environment, then crashes calling `localStorage.getItem()`.
 *
 * This runs before any application module and patches the global to a no-op so
 * Supabase (and any other browser-storage-aware library) behaves correctly in SSR.
 */
export async function register() {
  if (
    typeof localStorage !== 'undefined' &&
    typeof localStorage.getItem !== 'function'
  ) {
    Object.defineProperty(globalThis, 'localStorage', {
      value: {
        getItem: (_key: string): string | null => null,
        setItem: (_key: string, _value: string): void => {},
        removeItem: (_key: string): void => {},
        clear: (): void => {},
        key: (_index: number): string | null => null,
        length: 0,
      },
      writable: true,
      configurable: true,
    });
  }
}
