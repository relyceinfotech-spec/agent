import { AsyncLocalStorage } from "node:async_hooks";

// A request/job owns its diagnostics even when providers are shared across workers.
const operations = new AsyncLocalStorage<WeakMap<object, unknown>>();

export function withOperationContext<T>(operation: () => T): T {
  return operations.getStore() ? operation() : operations.run(new WeakMap(), operation);
}

export function operationState<T>(key: object, fallback: T, create: () => T): T {
  const scope = operations.getStore();
  if (!scope) return fallback;
  let state = scope.get(key) as T | undefined;
  if (!state) {
    state = create();
    scope.set(key, state);
  }
  return state;
}
