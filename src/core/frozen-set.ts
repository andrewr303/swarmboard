// A set that cannot change after it is made (closeout SEC-R1-2). `Object.freeze(new Set(...))` is not enough:
// a Set keeps its members in an internal slot that `add`, `delete` and `clear` reach through the prototype.
// This is a frozen view over a Set it closes over, so it has no `add`, `delete` or `clear` at all, and
// `Set.prototype.add.call(view, x)` is a TypeError (the view is not a Set). Internal: no barrel re-exports it.

/** A frozen `ReadonlySet` over `values`. */
export function frozenSet<T>(values: Iterable<T>): ReadonlySet<T> {
  const members = new Set(values)
  const view: ReadonlySet<T> = {
    get size(): number {
      return members.size
    },
    has: (value: T): boolean => members.has(value),
    forEach(callback: (value: T, key: T, set: ReadonlySet<T>) => void, thisArg?: unknown): void {
      for (const value of members) callback.call(thisArg, value, value, view)
    },
    entries: () => members.entries(),
    keys: () => members.keys(),
    values: () => members.values(),
    [Symbol.iterator]: () => members.values(),
  }
  return Object.freeze(view)
}
