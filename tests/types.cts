import { createHistory } from '@lp-labs/history';
import type { History, HistorySnapshot } from '@lp-labs/history';

const history: History<number> = createHistory(0);
const snapshot: HistorySnapshot<number> = history.getSnapshot();
const value: number = snapshot.value;
history.update((previous) => previous + value);
// @ts-expect-error CommonJS declarations preserve the value type.
history.reset('wrong');
