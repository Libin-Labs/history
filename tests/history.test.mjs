import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const esm = await import('@lp-labs/history');
const cjs = require('@lp-labs/history');

test('ESM and CommonJS expose the same named API', () => {
  assert.deepEqual(Object.keys(esm), ['createHistory']);
  assert.deepEqual(Object.keys(cjs), Object.keys(esm));
});

for (const [format, { createHistory }] of [
  ['esm', esm],
  ['cjs', cjs],
]) {
  const check = (name, callback) => test(`${format}: ${name}`, callback);

  check('initial status and frozen stable snapshot', () => {
    const history = createHistory('initial');
    const snapshot = history.getSnapshot();
    assert.deepEqual(snapshot, {
      value: 'initial',
      undoCount: 0,
      redoCount: 0,
      canUndo: false,
      canRedo: false,
    });
    assert.equal(history.getSnapshot(), snapshot);
    assert.ok(Object.isFrozen(snapshot));
    assert.ok(Object.isFrozen(history));
    assert.throws(() => {
      snapshot.value = 'changed';
    }, TypeError);
  });

  check('set, update, undo and redo with stable historical snapshots', () => {
    const history = createHistory(0);
    const initial = history.getSnapshot();
    assert.equal(history.set(1), true);
    const first = history.getSnapshot();
    assert.equal(
      history.update((value) => value + 1),
      true,
    );
    assert.equal(history.getSnapshot().undoCount, 2);
    assert.equal(history.undo(), true);
    assert.equal(history.getSnapshot().value, 1);
    assert.equal(history.getSnapshot().redoCount, 1);
    assert.equal(history.undo(), true);
    assert.equal(history.undo(), false);
    assert.equal(history.redo(), true);
    assert.equal(history.redo(), true);
    assert.equal(history.redo(), false);
    assert.equal(history.getSnapshot().value, 2);
    assert.equal(initial.value, 0);
    assert.equal(first.value, 1);
    assert.equal(first.redoCount, 0);
  });

  check('no-op operations preserve snapshot identity and do not notify', () => {
    const history = createHistory(0);
    let calls = 0;
    history.subscribe(() => {
      calls += 1;
    });
    const original = history.getSnapshot();
    for (const result of [
      history.set(0),
      history.update((value) => value),
      history.undo(),
      history.redo(),
      history.clear(),
      history.reset(0),
    ]) {
      assert.equal(result, false);
    }
    history.transaction(() => {});
    assert.equal(history.getSnapshot(), original);
    assert.equal(calls, 0);
  });

  check('default equality uses Object.is including NaN and signed zero', () => {
    const history = createHistory(NaN);
    assert.equal(history.set(NaN), false);
    assert.equal(history.set(0), true);
    assert.equal(history.set(-0), true);
    assert.ok(Object.is(history.getSnapshot().value, -0));
    history.undo();
    assert.ok(Object.is(history.getSnapshot().value, 0));
  });

  check('custom equality retains the old reference for equal replacements', () => {
    const original = { id: 1 };
    const history = createHistory(original, { equals: (a, b) => a.id === b.id });
    assert.equal(history.set({ id: 1 }), false);
    assert.equal(history.getSnapshot().value, original);
    history.set({ id: 2 });
    history.undo();
    const before = history.getSnapshot();
    assert.equal(history.set({ id: 1 }), false);
    assert.equal(history.getSnapshot(), before);
    assert.equal(history.getSnapshot().canRedo, true);
  });

  check('real branch edits invalidate redo', () => {
    const history = createHistory(0);
    history.set(1);
    history.set(2);
    history.undo();
    history.set(3);
    assert.equal(history.getSnapshot().redoCount, 0);
    assert.equal(history.redo(), false);
    history.undo();
    assert.equal(history.getSnapshot().value, 1);
  });

  check('capacity drops oldest states and redo stays bounded', () => {
    const history = createHistory(0, { capacity: 2 });
    for (const value of [1, 2, 3, 4]) history.set(value);
    assert.equal(history.getSnapshot().undoCount, 2);
    history.undo();
    history.undo();
    assert.equal(history.getSnapshot().value, 2);
    assert.equal(history.undo(), false);
    assert.equal(history.getSnapshot().redoCount, 2);
    history.redo();
    history.redo();
    assert.equal(history.getSnapshot().value, 4);
    assert.equal(history.getSnapshot().undoCount, 2);
  });

  check('default capacity is 100', () => {
    const history = createHistory(0);
    for (let value = 1; value <= 110; value += 1) history.set(value);
    assert.equal(history.getSnapshot().undoCount, 100);
    while (history.undo()) {}
    assert.equal(history.getSnapshot().value, 10);
  });

  check('zero capacity keeps values but no history', () => {
    const history = createHistory(0, { capacity: 0 });
    history.set(1);
    history.transaction((current) => {
      current.set(2);
      current.set(3);
    });
    assert.equal(history.getSnapshot().value, 3);
    assert.equal(history.getSnapshot().undoCount, 0);
    assert.equal(history.undo(), false);
    assert.equal(history.redo(), false);
    assert.equal(history.clear(), false);
  });

  check('invalid capacities and comparator are rejected', () => {
    for (const capacity of [-1, 1.5, NaN, Infinity, -Infinity, 2 ** 53, '2']) {
      assert.throws(() => createHistory(0, { capacity }), RangeError);
    }
    assert.throws(() => createHistory(0, { equals: 1 }), TypeError);
    createHistory(0, { capacity: Number.MAX_SAFE_INTEGER });
  });

  check('clear retains current value and reset establishes a new baseline', () => {
    const history = createHistory(0);
    history.set(1);
    history.set(2);
    history.undo();
    assert.equal(history.clear(), true);
    assert.equal(history.getSnapshot().value, 1);
    assert.equal(history.getSnapshot().undoCount, 0);
    assert.equal(history.getSnapshot().redoCount, 0);
    assert.equal(history.reset(3), true);
    assert.equal(history.getSnapshot().value, 3);
    assert.equal(history.undo(), false);
    history.set(4);
    assert.equal(history.reset(4), true);
    assert.equal(history.getSnapshot().undoCount, 0);
  });

  check('reset equal value keeps its reference while clearing redo', () => {
    const initial = { id: 1 };
    const history = createHistory(initial, { equals: (a, b) => a.id === b.id });
    history.set({ id: 2 });
    history.undo();
    assert.equal(history.reset({ id: 1 }), true);
    assert.equal(history.getSnapshot().value, initial);
    assert.equal(history.getSnapshot().redoCount, 0);
  });

  check('transactions group updates and return callback results', () => {
    const history = createHistory(0);
    const events = [];
    history.subscribe((next, previous) => {
      events.push([next.value, previous.value]);
    });
    const result = history.transaction((current) => {
      assert.equal(current, history);
      current.set(1);
      assert.equal(current.getSnapshot().value, 1);
      assert.equal(current.getSnapshot().undoCount, 0);
      current.update((value) => value + 1);
      assert.equal(events.length, 0);
      return 'done';
    });
    assert.equal(result, 'done');
    assert.deepEqual(events, [[2, 0]]);
    assert.equal(history.getSnapshot().undoCount, 1);
    history.undo();
    assert.equal(history.getSnapshot().value, 0);
    history.redo();
    assert.equal(history.getSnapshot().value, 2);
  });

  check('nested successful transactions form one outer step', () => {
    const history = createHistory(0);
    let calls = 0;
    history.subscribe(() => {
      calls += 1;
    });
    history.transaction((outer) => {
      outer.set(1);
      outer.transaction((inner) => {
        inner.set(2);
        inner.transaction((deep) => {
          deep.set(3);
        });
      });
      outer.set(4);
    });
    assert.equal(calls, 1);
    assert.equal(history.getSnapshot().undoCount, 1);
    history.undo();
    assert.equal(history.getSnapshot().value, 0);
  });

  check('failed transactions restore exact state including redo and notify nobody', () => {
    const history = createHistory(0);
    history.set(1);
    history.undo();
    const before = history.getSnapshot();
    const failure = new Error('fail');
    let calls = 0;
    history.subscribe(() => {
      calls += 1;
    });
    assert.throws(
      () =>
        history.transaction((current) => {
          current.set(2);
          throw failure;
        }),
      (error) => error === failure,
    );
    assert.equal(history.getSnapshot(), before);
    assert.equal(calls, 0);
    history.redo();
    assert.equal(history.getSnapshot().value, 1);
  });

  check('caught nested failure restores savepoint and outer transaction can continue', () => {
    const history = createHistory(0);
    history.transaction((outer) => {
      outer.set(1);
      const savepoint = outer.getSnapshot();
      assert.throws(
        () =>
          outer.transaction((inner) => {
            inner.set(2);
            throw new Error('nested');
          }),
        /nested/,
      );
      assert.equal(outer.getSnapshot(), savepoint);
      outer.set(3);
    });
    assert.equal(history.getSnapshot().value, 3);
    assert.equal(history.getSnapshot().undoCount, 1);
    history.undo();
    assert.equal(history.getSnapshot().value, 0);
  });

  check('uncaught nested failure rolls back the outer transaction', () => {
    const history = createHistory(0);
    const original = history.getSnapshot();
    assert.throws(
      () =>
        history.transaction((outer) => {
          outer.set(1);
          outer.transaction((inner) => {
            inner.set(2);
            throw new Error('nested');
          });
        }),
      /nested/,
    );
    assert.equal(history.getSnapshot(), original);
    history.set(3);
    assert.equal(history.getSnapshot().undoCount, 1);
  });

  check('net-equal transactions preserve original identity and redo', () => {
    const history = createHistory({ id: 0 }, { equals: (a, b) => a.id === b.id });
    history.set({ id: 1 });
    history.undo();
    const before = history.getSnapshot();
    let calls = 0;
    history.subscribe(() => {
      calls += 1;
    });
    history.transaction((current) => {
      current.set({ id: 2 });
      current.set({ id: 0 });
    });
    assert.equal(history.getSnapshot(), before);
    assert.equal(calls, 0);
    assert.equal(history.getSnapshot().canRedo, true);
  });

  check('nested net-equal transaction restores its entry reference', () => {
    const history = createHistory(0);
    history.transaction((outer) => {
      outer.set(1);
      const before = outer.getSnapshot();
      outer.transaction((inner) => {
        inner.set(2);
        inner.set(1);
      });
      assert.equal(outer.getSnapshot(), before);
    });
    assert.equal(history.getSnapshot().value, 1);
  });

  check('committed transactions invalidate branches and obey bounds', () => {
    const history = createHistory(0, { capacity: 1 });
    history.set(1);
    history.set(2);
    history.undo();
    history.transaction((current) => {
      current.set(3);
      current.set(4);
    });
    assert.equal(history.getSnapshot().redoCount, 0);
    assert.equal(history.getSnapshot().undoCount, 1);
    history.undo();
    assert.equal(history.getSnapshot().value, 1);
    assert.equal(history.undo(), false);
  });

  check('only set and update may mutate during a transaction', () => {
    for (const method of ['undo', 'redo', 'clear', 'reset', 'dispose']) {
      const history = createHistory(0);
      const before = history.getSnapshot();
      assert.throws(
        () =>
          history.transaction((current) => {
            current.set(1);
            current[method](2);
          }),
        /transaction/,
      );
      assert.equal(history.getSnapshot(), before);
      assert.equal(history.isDisposed(), false);
    }
  });

  check('Promise and thenable results roll back synchronously', () => {
    for (const result of [Promise.resolve(2), { then() {} }]) {
      const history = createHistory(0);
      const before = history.getSnapshot();
      assert.throws(
        () =>
          history.transaction((current) => {
            current.set(1);
            return result;
          }),
        TypeError,
      );
      assert.equal(history.getSnapshot(), before);
      history.set(2);
      assert.equal(history.getSnapshot().value, 2);
    }
  });

  check('throwing or mutating then getters cannot escape rollback', () => {
    const history = createHistory(0);
    const before = history.getSnapshot();
    assert.throws(
      () =>
        history.transaction((current) => {
          current.set(1);
          return {
            get then() {
              current.set(2);
            },
          };
        }),
      /Reentrant/,
    );
    assert.equal(history.getSnapshot(), before);
    assert.throws(
      () =>
        history.transaction(() => ({
          get then() {
            throw new Error('getter');
          },
        })),
      /getter/,
    );
    assert.equal(history.getSnapshot(), before);
  });

  check('updater and comparator failures are atomic', () => {
    let shouldThrow = false;
    const history = createHistory(0, {
      equals: (a, b) => {
        if (shouldThrow) throw new Error('comparison');
        return a === b;
      },
    });
    history.set(1);
    const before = history.getSnapshot();
    assert.throws(
      () =>
        history.update(() => {
          throw new Error('updater');
        }),
      /updater/,
    );
    shouldThrow = true;
    assert.throws(() => history.set(2), /comparison/);
    assert.throws(() => history.reset(2), /comparison/);
    assert.equal(history.getSnapshot(), before);
    shouldThrow = false;
    history.set(2);
    assert.equal(history.getSnapshot().value, 2);
  });

  check('final transaction comparator failure restores the entry state', () => {
    let fail = false;
    const history = createHistory(0, {
      equals: (a, b) => {
        if (fail) throw new Error('final compare');
        return a === b;
      },
    });
    const before = history.getSnapshot();
    assert.throws(
      () =>
        history.transaction((current) => {
          current.set(1);
          fail = true;
        }),
      /final compare/,
    );
    assert.equal(history.getSnapshot(), before);
  });

  check('reentrant updater and comparator mutations are rejected', () => {
    const history = createHistory(0);
    assert.throws(
      () =>
        history.update(() => {
          history.set(1);
          return 2;
        }),
      /Reentrant/,
    );
    assert.equal(history.getSnapshot().value, 0);
    let compared;
    compared = createHistory(0, {
      equals: () => {
        compared.clear();
        return false;
      },
    });
    assert.throws(() => compared.set(1), /Reentrant/);
    assert.equal(compared.getSnapshot().value, 0);
  });

  check('subscriptions are ordered, not immediate, and independently removable', () => {
    const history = createHistory(0);
    const events = [];
    const listener = (next, previous) => {
      events.push([next.value, previous.value]);
    };
    const stopOne = history.subscribe(listener);
    const stopTwo = history.subscribe(listener);
    assert.deepEqual(events, []);
    history.set(1);
    assert.deepEqual(events, [
      [1, 0],
      [1, 0],
    ]);
    stopOne();
    stopOne();
    history.set(2);
    assert.equal(events.length, 3);
    stopTwo();
    history.set(3);
    assert.equal(events.length, 3);
    assert.throws(() => history.subscribe(null), TypeError);
  });

  check('subscription changes during notification affect only later events', () => {
    const history = createHistory(0);
    const events = [];
    let stopSecond;
    let registered = false;
    history.subscribe(() => {
      events.push('first');
      stopSecond();
      if (!registered) {
        registered = true;
        history.subscribe(() => {
          events.push('third');
        });
      }
    });
    stopSecond = history.subscribe(() => {
      events.push('second');
    });
    history.set(1);
    assert.deepEqual(events, ['first', 'second']);
    events.length = 0;
    history.set(2);
    assert.deepEqual(events, ['first', 'third']);
  });

  check('all subscriber errors aggregate after commit and remaining delivery', () => {
    const history = createHistory(0);
    const first = new Error('first');
    const second = 'second';
    const events = [];
    const stopFirst = history.subscribe(() => {
      throw first;
    });
    const stopSecond = history.subscribe(() => {
      throw second;
    });
    history.subscribe((next) => {
      events.push(next.value);
    });
    assert.throws(
      () => history.set(1),
      (error) => {
        assert.ok(error instanceof AggregateError);
        assert.deepEqual(error.errors, [first, second]);
        return true;
      },
    );
    assert.deepEqual(events, [1]);
    assert.equal(history.getSnapshot().value, 1);
    stopFirst();
    stopSecond();
    history.set(2);
    assert.deepEqual(events, [1, 2]);
  });

  check('subscriber mutation and disposal are rejected without corrupting delivery', () => {
    const history = createHistory(0);
    const errors = [];
    history.subscribe(() => {
      for (const action of [
        () => history.set(9),
        () => history.update((value) => value + 1),
        () => history.undo(),
        () => history.redo(),
        () => history.reset(9),
        () => history.clear(),
        () => history.transaction(() => {}),
        () => history.dispose(),
      ]) {
        assert.throws(action, /Reentrant/);
        errors.push(true);
      }
      assert.equal(history.getSnapshot().value, 1);
    });
    history.set(1);
    assert.equal(errors.length, 8);
    assert.equal(history.isDisposed(), false);
    assert.equal(history.getSnapshot().undoCount, 1);
  });

  check('transaction notification errors do not roll back committed history', () => {
    const history = createHistory(0);
    const stop = history.subscribe(() => {
      throw new Error('listener');
    });
    assert.throws(
      () =>
        history.transaction((current) => {
          current.set(1);
          current.set(2);
        }),
      AggregateError,
    );
    assert.equal(history.getSnapshot().value, 2);
    assert.equal(history.getSnapshot().undoCount, 1);
    stop();
    history.undo();
    assert.equal(history.getSnapshot().value, 0);
  });

  check('undo, redo, clear and reset notify on status-only changes too', () => {
    const history = createHistory(0);
    const events = [];
    history.subscribe((next, previous) => {
      events.push([next, previous]);
    });
    history.set(1);
    history.undo();
    history.redo();
    history.clear();
    history.set(2);
    history.reset(2);
    assert.equal(events.length, 6);
    assert.equal(events[3][0].value, events[3][1].value);
    assert.equal(events[5][0].value, events[5][1].value);
    assert.equal(events[5][0].undoCount, 0);
  });

  check('undefined, null and function values are supported without sentinel collisions', () => {
    const history = createHistory(undefined);
    const fn = () => 1;
    history.set(null);
    history.set(fn);
    history.undo();
    assert.equal(history.getSnapshot().value, null);
    history.undo();
    assert.equal(history.getSnapshot().value, undefined);
    history.redo();
    history.redo();
    assert.equal(history.getSnapshot().value, fn);
  });

  check('values are retained by reference, not cloned or deeply frozen', () => {
    const initial = { nested: { count: 0 } };
    const history = createHistory(initial);
    assert.equal(history.getSnapshot().value, initial);
    assert.equal(Object.isFrozen(initial), false);
    const next = { nested: { count: 1 } };
    history.set(next);
    assert.equal(history.getSnapshot().value, next);
    history.undo();
    assert.equal(history.getSnapshot().value, initial);
  });

  check('dispose clears subscribers, is idempotent and preserves readable state', () => {
    const history = createHistory(0);
    let calls = 0;
    const stop = history.subscribe(() => {
      calls += 1;
    });
    history.set(1);
    const before = history.getSnapshot();
    assert.equal(history.isDisposed(), false);
    history.dispose();
    history.dispose();
    stop();
    assert.equal(history.isDisposed(), true);
    assert.equal(history.getSnapshot(), before);
    assert.equal(calls, 1);
    for (const action of [
      () => history.set(1),
      () => history.update((v) => v),
      () => history.undo(),
      () => history.redo(),
      () => history.clear(),
      () => history.reset(1),
      () => history.transaction(() => {}),
      () => history.subscribe(() => {}),
    ]) {
      assert.throws(action, /disposed/);
    }
  });

  check('extracted methods do not depend on this', () => {
    const { set, getSnapshot, undo, redo, update, clear, reset, transaction, dispose } =
      createHistory(0);
    set(1);
    undo();
    redo();
    update((value) => value + 1);
    transaction((current) => {
      current.set(3);
    });
    assert.equal(getSnapshot().value, 3);
    clear();
    reset(0);
    dispose();
  });

  check('deterministic mixed operations match a bounded reference model', () => {
    for (const capacity of [0, 1, 5]) {
      const history = createHistory(0, { capacity });
      let value = 0;
      let past = [];
      let future = [];
      let seed = 123456;
      for (let index = 0; index < 600; index += 1) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        const operation = seed % 6;
        const next = (seed >>> 8) % 17;
        if (operation === 0 || operation === 1) {
          if (operation === 0) history.set(next);
          else
            history.transaction((current) => {
              current.set(99);
              current.set(next);
            });
          if (!Object.is(value, next)) {
            past = [...past, value].slice(-capacity);
            if (capacity === 0) past = [];
            value = next;
            future = [];
          }
        } else if (operation === 2) {
          history.undo();
          if (past.length > 0) {
            future.push(value);
            value = past.pop();
          }
        } else if (operation === 3) {
          history.redo();
          if (future.length > 0) {
            past.push(value);
            value = future.pop();
          }
        } else if (operation === 4) {
          history.clear();
          past = [];
          future = [];
        } else {
          history.reset(next);
          value = next;
          past = [];
          future = [];
        }
        assert.deepEqual(history.getSnapshot(), {
          value,
          undoCount: past.length,
          redoCount: future.length,
          canUndo: past.length > 0,
          canRedo: future.length > 0,
        });
      }
    }
  });
}
