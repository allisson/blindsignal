/** A minimal typed event emitter; `on` returns the function that removes the listener. */
export class Emitter<Events extends Record<string, unknown>> {
  readonly #listeners = new Map<keyof Events, Set<(value: never) => void>>();

  on<K extends keyof Events>(event: K, listener: (value: Events[K]) => void): () => void {
    const listeners = this.#listeners.get(event) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(event, listeners);
    return () => listeners.delete(listener);
  }

  protected emit<K extends keyof Events>(event: K, value: Events[K]): void {
    for (const listener of [...(this.#listeners.get(event) ?? [])]) {
      try {
        (listener as (value: Events[K]) => void)(value);
      } catch (error) {
        // An application listener that throws must not break the SDK's message handling.
        queueMicrotask(() => {
          throw error;
        });
      }
    }
  }
}
