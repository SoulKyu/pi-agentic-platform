export function once<A extends unknown[]>(fn: (...args: A) => void): (...args: A) => boolean {
  let done = false;
  return (...args) => {
    if (done) return false;
    done = true;
    fn(...args);
    return true;
  };
}
