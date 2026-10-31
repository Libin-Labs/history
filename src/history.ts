export interface HistoryOptions<T> {
  /** Maximum retained undo steps. Defaults to 100. */
  readonly capacity?: number;
  /** Pure equivalence relation. Defaults to Object.is. */
  readonly equals?: (left: T, right: T) => boolean;
}

export interface HistorySnapshot<T> {
  readonly value: T;
  readonly undoCount: number;
  readonly redoCount: number;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
}

export type HistoryListener<T> = (
  snapshot: HistorySnapshot<T>,
  previous: HistorySnapshot<T>,
) => void;

export interface History<T> {
  getSnapshot(): HistorySnapshot<T>;
  set(value: T): boolean;
  update(updater: (value: T) => T): boolean;
  undo(): boolean;
  redo(): boolean;
  reset(value: T): boolean;
  clear(): boolean;
  transaction<R>(callback: (history: History<T>) => R): R;
  subscribe(listener: HistoryListener<T>): () => void;
  dispose(): void;
  isDisposed(): boolean;
}

interface State<T> {
  readonly past: readonly T[];
  readonly future: readonly T[];
  readonly snapshot: HistorySnapshot<T>;
}

function makeState<T>(value: T, past: readonly T[], future: readonly T[]): State<T> {
  return {
    past,
    future,
    snapshot: Object.freeze({
      value,
      undoCount: past.length,
      redoCount: future.length,
      canUndo: past.length > 0,
      canRedo: future.length > 0,
    }),
  };
}

function isThenable(value: unknown): boolean {
  return (
    value !== null &&
    (typeof value === 'object' || typeof value === 'function') &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

export function createHistory<T>(initialValue: T, options: HistoryOptions<T> = {}): History<T> {
  const capacity = options.capacity ?? 100;
  const equals = options.equals ?? Object.is;
  if (!Number.isSafeInteger(capacity) || capacity < 0) {
    throw new RangeError('capacity must be a non-negative safe integer');
  }
  if (typeof equals !== 'function') {
    throw new TypeError('equals must be a function');
  }

  let state = makeState(initialValue, [], []);
  let disposed = false;
  let notifying = false;
  let evaluating = false;
  let transactionDepth = 0;
  const listeners = new Set<{ listener: HistoryListener<T> }>();

  function assertWritable(): void {
    if (disposed) {
      throw new Error('History has been disposed');
    }
    if (notifying || evaluating) {
      throw new Error('Reentrant history mutation is not allowed');
    }
  }

  function assertOutsideTransaction(): void {
    assertWritable();
    if (transactionDepth > 0) {
      throw new Error('Only set, update, and nested transactions may mutate a transaction');
    }
  }

  function evaluate<R>(callback: () => R): R {
    evaluating = true;
    try {
      return callback();
    } finally {
      evaluating = false;
    }
  }

  function appendPast(base: State<T>): readonly T[] {
    if (capacity === 0) {
      return [];
    }
    return [...base.past.slice(Math.max(0, base.past.length + 1 - capacity)), base.snapshot.value];
  }

  function notify(previous: State<T>): void {
    const snapshot = state.snapshot;
    const errors: unknown[] = [];
    notifying = true;
    try {
      // Capture registrations so changes during delivery affect the next event.
      for (const { listener } of [...listeners]) {
        try {
          listener(snapshot, previous.snapshot);
        } catch (error) {
          errors.push(error);
        }
      }
    } finally {
      notifying = false;
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, 'History subscriber errors (change committed)');
    }
  }

  function set(value: T): boolean {
    assertWritable();
    if (evaluate(() => equals(state.snapshot.value, value))) {
      return false;
    }
    const previous = state;
    state = makeState(
      value,
      transactionDepth > 0 ? previous.past : appendPast(previous),
      transactionDepth > 0 ? previous.future : [],
    );
    if (transactionDepth === 0) {
      notify(previous);
    }
    return true;
  }

  const history: History<T> = {
    getSnapshot: () => state.snapshot,
    set,
    update(updater) {
      assertWritable();
      const value = evaluate(() => updater(state.snapshot.value));
      return set(value);
    },
    undo() {
      assertOutsideTransaction();
      if (state.past.length === 0) {
        return false;
      }
      const previous = state;
      state = makeState(previous.past[previous.past.length - 1] as T, previous.past.slice(0, -1), [
        ...previous.future,
        previous.snapshot.value,
      ]);
      notify(previous);
      return true;
    },
    redo() {
      assertOutsideTransaction();
      if (state.future.length === 0) {
        return false;
      }
      const previous = state;
      state = makeState(
        previous.future[previous.future.length - 1] as T,
        appendPast(previous),
        previous.future.slice(0, -1),
      );
      notify(previous);
      return true;
    },
    reset(value) {
      assertOutsideTransaction();
      const equal = evaluate(() => equals(state.snapshot.value, value));
      if (equal && state.past.length === 0 && state.future.length === 0) {
        return false;
      }
      const previous = state;
      state = makeState(equal ? previous.snapshot.value : value, [], []);
      notify(previous);
      return true;
    },
    clear() {
      assertOutsideTransaction();
      if (state.past.length === 0 && state.future.length === 0) {
        return false;
      }
      const previous = state;
      state = makeState(previous.snapshot.value, [], []);
      notify(previous);
      return true;
    },
    transaction<R>(callback: (history: History<T>) => R): R {
      assertWritable();
      const previous = state;
      const outermost = transactionDepth === 0;
      transactionDepth += 1;
      let result: R;
      try {
        result = callback(history);
        if (evaluate(() => isThenable(result))) {
          throw new TypeError('History transactions must be synchronous');
        }
        if (
          state === previous ||
          evaluate(() => equals(previous.snapshot.value, state.snapshot.value))
        ) {
          state = previous;
        } else if (outermost) {
          state = makeState(state.snapshot.value, appendPast(previous), []);
        }
      } catch (error) {
        state = previous;
        throw error;
      } finally {
        transactionDepth -= 1;
      }
      // Notification failures occur after commit and must not trigger rollback.
      if (outermost && state !== previous) {
        notify(previous);
      }
      return result;
    },
    subscribe(listener) {
      if (disposed) {
        throw new Error('History has been disposed');
      }
      if (typeof listener !== 'function') {
        throw new TypeError('listener must be a function');
      }
      const registration = { listener };
      listeners.add(registration);
      return () => {
        listeners.delete(registration);
      };
    },
    dispose() {
      if (disposed) {
        return;
      }
      assertOutsideTransaction();
      listeners.clear();
      disposed = true;
    },
    isDisposed: () => disposed,
  };

  return Object.freeze(history);
}
