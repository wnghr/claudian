import timers from 'node:timers';

const realSetTimeout = setTimeout;
const realNow = Date.now;

// Advance application timers without virtualizing the loopback socket event loop.
export function eventTransportClock() {
  jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
  const timeout = jest.spyOn(timers, 'setTimeout').mockImplementation(setTimeout);
  const clear = jest.spyOn(timers, 'clearTimeout').mockImplementation(clearTimeout);
  return {
    async advance(milliseconds: number): Promise<void> {
      await jest.advanceTimersByTimeAsync(milliseconds);
      await new Promise<void>(resolve => realSetTimeout(resolve, 10));
    },
    restore(): void {
      timeout.mockRestore();
      clear.mockRestore();
      jest.useRealTimers();
    },
  };
}

export async function waitForSocket(predicate: () => boolean): Promise<void> {
  const deadline = realNow() + 5_000;
  while (!predicate()) {
    if (realNow() >= deadline) throw new Error('Timed out waiting for loopback socket');
    await new Promise<void>(resolve => realSetTimeout(resolve, 10));
  }
}
