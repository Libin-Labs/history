import { createHistory } from '@lp-labs/history';
import type { History, HistoryListener, HistoryOptions, HistorySnapshot } from '@lp-labs/history';

const options: HistoryOptions<Readonly<{ count: number }>> = {
  capacity: 5,
  equals: (a, b) => a.count === b.count,
};
const history: History<Readonly<{ count: number }>> = createHistory({ count: 0 }, options);
const snapshot: HistorySnapshot<Readonly<{ count: number }>> = history.getSnapshot();
const listener: HistoryListener<Readonly<{ count: number }>> = (next, previous) => {
  const delta: number = next.value.count - previous.value.count;
  void delta;
};
history.subscribe(listener)();
history.update((value) => ({ count: value.count + 1 }));
const result: string = history.transaction((current) => {
  current.set({ count: 2 });
  return 'done';
});
void result;
// @ts-expect-error Snapshot metadata is readonly.
snapshot.canUndo = false;
// @ts-expect-error The value type remains readonly.
snapshot.value.count = 3;
// @ts-expect-error Values must match the initial value's type.
history.set('wrong');
// @ts-expect-error Comparator parameters retain the value type.
createHistory(0, { equals: (left: string, right: string) => left === right });

createHistory<number | undefined>(undefined).set(1);
createHistory<null | string>(null).set('value');
