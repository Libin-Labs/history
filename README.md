# @lp-labs/history

Typed, bounded undo/redo history with synchronous transaction grouping. Version
0.1.0 supports Node.js 18 and later, ESM and CommonJS, with matching TypeScript
declarations. It has no runtime dependencies, React integration, sibling-package
imports, or shared workspace code. It can be installed and used independently.
This independence statement is not a legal certification.

No React, CSS, browser APIs, or Node ambient declarations are required. Importing
the module starts no browser work; all operations run on the calling thread.

## Installation

```sh
npm install @lp-labs/history
```

```ts
import { createHistory } from "@lp-labs/history";

const history = createHistory(0, { capacity: 50 });
const unsubscribe = history.subscribe((next, previous) => {
  console.log(previous.value, "->", next.value);
});

history.set(1);
history.update((value) => value + 1);
history.undo(); // value: 1
history.redo(); // value: 2
console.log(history.getSnapshot());
// { value: 2, undoCount: 2, redoCount: 0, canUndo: true, canRedo: false }

unsubscribe();
history.dispose();
```

CommonJS exposes the same named API:

```js
const { createHistory } = require("@lp-labs/history");

const history = createHistory("draft");
history.set("complete");
history.undo();
console.log(history.getSnapshot().value); // "draft"
```

## Public API and types

The only runtime export is `createHistory`. All four types below are named type
exports. Methods can be destructured; none depends on `this`.

```ts
interface HistoryOptions<T> {
  readonly capacity?: number;
  readonly equals?: (left: T, right: T) => boolean;
}

interface HistorySnapshot<T> {
  readonly value: T;
  readonly undoCount: number;
  readonly redoCount: number;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
}

type HistoryListener<T> = (
  snapshot: HistorySnapshot<T>,
  previous: HistorySnapshot<T>,
) => void;

interface History<T> {
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

declare function createHistory<T>(
  initialValue: T,
  options?: HistoryOptions<T>,
): History<T>;
```

| Option | Default | Contract |
| --- | --- | --- |
| `capacity` | `100` | Non-negative safe integer: maximum undo steps, excluding the current value. `0` retains only the current value; editing and notifications still work. |
| `equals` | `Object.is` | Pure, synchronous equivalence relation. Called with the current/entry value on the left and candidate/final value on the right. Must not mutate values or history. |

`Object.is` treats `NaN` as equal to itself and distinguishes `0` from `-0`.
Objects are compared by identity unless you customize `equals`. Supply an
explicit generic for unions, readonly data, or initial values that are narrower
than the complete state type.

| Method | Behavior |
| --- | --- |
| `getSnapshot()` | Returns the current shallow-frozen snapshot. Repeated reads return the same object until state changes. |
| `set(value)` | Replaces the current value, adds one undo step, and discards redo. Equal replacements return `false`, preserve the old value reference, snapshot identity, and redo branch. |
| `update(updater)` | Calls the updater once with the current value, then applies `set` semantics. The updater must not mutate its argument or reenter a mutating history method. |
| `undo()` | Moves one step backward; the departed value becomes redoable. Returns `false` at the oldest retained state. |
| `redo()` | Moves one step forward; the departed value becomes undoable. Returns `false` at the newest state. |
| `reset(value)` | Establishes a new baseline and empties both stacks. Equal values preserve the old value reference, but existing undo/redo steps are still cleared. |
| `clear()` | Empties both stacks without changing the current value. This operation is not undoable. |
| `transaction(callback)` | Runs synchronously, returns the callback result, and groups successful edits into one undo step. See policy below. |
| `subscribe(listener)` | Registers a synchronous listener; returns an idempotent unsubscribe function. Does not call the listener immediately. |
| `dispose()` | Silently removes all subscribers and permanently disables writes and new subscriptions. Idempotent. Does not change the last snapshot or release its retained history values. |
| `isDisposed()` | Returns whether `dispose()` has completed. Initially `false`. |

Except for `transaction`, all boolean-returning methods return `true` for a
change and `false` for a no-op. No-ops do not notify and preserve snapshot
identity. `reset` and `clear` notify when stack availability changes even if the
value is unchanged. With no retained history, an equal reset or clear is a no-op.
Subscriber errors can make a changed operation throw instead of returning.

## Immutable values and snapshot ownership

History never mutates supplied values. It retains **references**, not deep copies;
it does not freeze values or serialize them. The snapshot wrapper and public
controller are frozen, but `snapshot.value` is only as immutable as your data.
Do not mutate any value passed into, read from, or retained by history, including
inside an updater, comparator, transaction, or listener. Such mutations cannot be
detected or rolled back and can corrupt the meaning of older states.

Create replacements, use readonly TypeScript types, or clone/freeze your own
values before supplying them. Snapshot fields are readonly; the generic `T`
itself is not automatically made deeply readonly.

```ts
import { createHistory } from "@lp-labs/history";
import type { HistoryOptions } from "@lp-labs/history";

type Document = Readonly<{
  title: string;
  tags: readonly string[];
}>;

const options: HistoryOptions<Document> = {
  capacity: 20,
  equals: (a, b) =>
    a.title === b.title &&
    a.tags.length === b.tags.length &&
    a.tags.every((tag, index) => tag === b.tags[index]),
};

const history = createHistory<Document>(
  { title: "Untitled", tags: [] },
  options,
);
history.update((document) => ({
  ...document,
  tags: [...document.tags, "important"],
}));
history.set({ title: "Untitled", tags: ["important"] }); // equal: no new step
history.undo(); // restores the original document reference
```

## Transactions and nested failure policy

Only `set`, `update`, and nested `transaction` calls may mutate history inside a
transaction. `undo`, `redo`, `reset`, `clear`, and `dispose` throw there, even when
they would otherwise be no-ops.

- Edits are visible immediately to `getSnapshot()` inside the callback, but do
  not notify. Counts and availability describe the entry stacks until commit;
  undo/redo are forbidden while the transaction is active.
- The outermost successful transaction creates exactly one undo step and one
  notification, respecting capacity and invalidating redo.
- If the final value equals the entry value, the exact entry snapshot and value
  reference are restored. No step or notification is created; redo survives.
  The same normalization applies at each nested transaction boundary.
- Each nested transaction is a savepoint. If it throws, only its edits are
  restored. An outer callback can catch the error and continue. If an error
  escapes the outer callback, all its edits are restored, including both stacks.
- Updater, comparator, callback, and thenable-detection errors roll back the
  affected transaction. Notification errors happen **after commit** and never
  roll it back.
- Subscriptions/unsubscriptions and external side effects are not transactional.
  Snapshots retained from a failed transaction remain readable but describe
  tentative, uncommitted values.

```ts
import { createHistory } from "@lp-labs/history";

const history = createHistory({ x: 0, y: 0 });
const result = history.transaction((outer) => {
  outer.update((point) => ({ ...point, x: 10 }));
  try {
    outer.transaction((inner) => {
      inner.set({ x: 99, y: 99 });
      throw new Error("cancel this nested edit");
    });
  } catch {
    // The outer edit x: 10 survives this caught nested failure.
  }
  outer.update((point) => ({ ...point, y: 20 }));
  return "moved";
});
console.log(result); // "moved"
history.undo(); // { x: 0, y: 0 }, a single step
history.redo(); // { x: 10, y: 20 }
```

Transactions must be synchronous. A Promise or other callable-`then` result
causes a synchronous `TypeError` and rollback. This is a runtime check; the
generic callback signature does not reject async functions at compile time.
Do not pass async callbacks: history cannot cancel their execution, prevent
later async writes, or handle rejections from their abandoned promises. Await
external work first, then apply its result in a synchronous transaction.

## Subscriptions, errors, and concurrency

Delivery is synchronous in registration order, once per committed operation.
Listeners receive the next and previous snapshots. Registering the same function
twice creates two independent subscriptions. A notification captures its
registration list before delivery: subscriptions added or removed during
delivery affect the next event, not the current one. Reading, subscribing, and
unsubscribing during delivery are allowed.

Every listener in that captured list is called even if earlier listeners throw.
All thrown values are collected in registration order in an `AggregateError`
with an `errors` array. The mutating call throws that aggregate **after the state
has committed**. A single thrown value also produces an `AggregateError`. Check
the current snapshot before deciding whether to retry a failed operation.
Listeners must be synchronous: returned values and promises are ignored, and
async rejections are not captured.

Reentrant mutation (including disposal) during a listener, equality comparator,
or updater throws `Error`. A listener's uncaught reentrancy error is aggregated
like any other listener error; it does not revert the committed change.

```ts
import { createHistory } from "@lp-labs/history";

const history = createHistory(0);
const stop = history.subscribe(() => {
  throw new Error("view failed to refresh");
});
try {
  history.set(1);
} catch (error) {
  if (!(error instanceof AggregateError)) throw error;
  console.log(error.errors.length); // 1
  console.log(history.getSnapshot().value); // 1, already committed
}
stop();
history.clear(); // drops undo/redo; keeps value 1
history.reset(0); // establishes a new baseline
history.dispose();
console.log(history.isDisposed()); // true
console.log(history.getSnapshot().value); // 0, still readable
```

### Error reference

| Condition | Result |
| --- | --- |
| Invalid capacity (negative, fractional, unsafe, or non-finite) | `RangeError` during creation. |
| Non-function comparator or subscriber | `TypeError`. |
| Non-function updater or transaction callback in untyped JavaScript | `TypeError` on invocation; no state commit. |
| Promise/thenable transaction result | `TypeError` and rollback. Accessor errors while inspecting `then` propagate and roll back. |
| Forbidden transaction operation or reentrant mutation | `Error`; propagates or participates in rollback/notification aggregation as described above. |
| Mutating method or `subscribe` after disposal, including no-ops | `Error`. `getSnapshot`, `isDisposed`, `dispose`, and existing unsubscribe functions remain usable. |
| Callback, comparator, or updater throws | Original thrown value propagates; no partial history commit. An enclosing transaction restores its entry state if the error escapes. |
| Listener throws | `AggregateError` after commit; remaining listeners are still called. |

Exact error messages are not part of the API contract.

Each instance is independent and runs synchronously on the calling JavaScript
thread. There is no locking, async transaction isolation, cross-thread sharing,
cross-instance atomicity, or background work. Async work outside history can
complete out of order; coordinate it in your application.

## Limits

- The bound counts transitions, not bytes. Together the undo and redo stacks
  retain at most `capacity` prior/next values, plus the current value.
- Capacity is fixed at creation; edits beyond it discard the oldest undo
  states. Discarded states cannot be recovered.
- Edits and navigation copy arrays, taking O(capacity) time/temporary space in
  the worst case, plus comparator and listener costs. Snapshot reads are O(1).
- Caller-retained snapshots, transaction savepoints, external references, and
  listener closures are outside the capacity bound. Deep object graphs can
  retain large amounts of memory.
- There is no persistence, serialization, patch/diff engine, branching tree,
  automatic cloning, or framework integration. New real edits discard redo.
- Disposal is subscription teardown/write protection, not secure erasure or
  guaranteed immediate garbage collection.

## License

[MIT](./LICENSE).

## Support

If this library is useful to you, consider supporting its maintenance with a [donation via PayPal](https://www.paypal.me/LibinPrasanth).

## Author

Created by [Libin Prasanth](https://www.linkedin.com/in/libinprasanth/). Connect on LinkedIn for updates and discussion.
