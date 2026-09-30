// 并发限流器（p-limit 模式自实现，spec §5.3）
export function createLimiter(n: number): <T>(fn: () => Promise<T>) => Promise<T> {
  let active = 0;
  const queue: Array<() => void> = [];
  const next = () => {
    active--;
    queue.shift()?.();
  };
  return function limit<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      const run = () => {
        active++;
        fn().then(
          (v) => { resolve(v); next(); },
          (e) => { reject(e); next(); }
        );
      };
      if (active < n) run();
      else queue.push(run);
    });
  };
}