export type TestClock = { now(): Date; advance(ms: number): void };

export function createTestClock(start: Date): TestClock {
  let current = start.getTime();
  return {
    now: () => new Date(current),
    advance(ms: number) {
      current += ms;
    },
  };
}
