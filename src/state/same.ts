/** For polled data: returns `prev` itself when `next` has the same content, so a `setState`
 *  (or zustand `set`) with it is a no-op and nothing re-renders. A poll that finds nothing new
 *  must not cost a render. */
export function keepIfSame<T>(prev: T, next: T): T {
  try {
    return JSON.stringify(prev) === JSON.stringify(next) ? prev : next;
  } catch {
    return next;
  }
}
