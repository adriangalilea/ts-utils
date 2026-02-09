/**
 * OFFENSIVE PROGRAMMING PRIMITIVES
 *
 * "A confused program SHOULD scream" - John Carmack
 *
 * Throw, always. An uncaught Panic crashes the process with a full stack trace.
 * Zero dependencies. Works identically in Node, Deno, Bun, and browsers.
 *
 * Four primitives:
 *   assert(cond, ...msg)   - invariant checking, narrows types
 *   panic(...msg)          - impossible state reached
 *   must(() => expr)       - unwrap-or-die for operations (sync + async)
 *   unwrap(value, ...msg)  - unwrap nullable values
 *
 * must() replaces the old try/catch/check pattern:
 *
 *   // before: 5 lines
 *   try {
 *     const data = readFileSync(path, 'utf-8')
 *     return data
 *   } catch (err) {
 *     check(err)
 *   }
 *
 *   // after: 1 line
 *   return must(() => readFileSync(path, 'utf-8'))
 */
/**
 * Distinct error class for offensive programming failures.
 * Distinguishes bugs from runtime errors at catch boundaries.
 *
 * @example
 * // In a server — let Panics crash, handle everything else
 * app.use((err, req, res, next) => {
 *   if (err instanceof Panic) throw err  // bug, re-throw, let it crash
 *   res.status(500).json({ error: 'internal error' })
 * })
 *
 * // In tests — assert that code panics
 * expect(() => assert(false, 'boom')).toThrow(Panic)
 */
export declare class Panic extends Error {
    constructor(message: string);
}
/**
 * Assert throws if condition is false. Narrows types via `asserts condition`.
 *
 * @example
 * assert(data.length > 0, 'empty packet')
 * assert(port > 0 && port < 65536, 'invalid port:', port)
 */
export declare function assert(condition: boolean, ...msg: any[]): asserts condition;
/**
 * Panic throws immediately. Use when the program reaches an impossible state.
 *
 * @example
 * switch (state) {
 *   case 'ready': handleReady(); break
 *   case 'loading': handleLoading(); break
 *   default: panic('impossible state:', state)
 * }
 */
export declare function panic(...msg: any[]): never;
/**
 * Must unwraps an operation that should never fail. Handles sync and async.
 *
 * @example
 * const data = must(() => JSON.parse(staticJsonString))
 * const file = await must(() => fs.promises.readFile(path))
 * const buf = must(() => readFileSync(path))
 */
export declare function must<T>(fn: () => Promise<T>): Promise<T>;
export declare function must<T>(fn: () => T): T;
/**
 * Unwrap a nullable value or throw. Like Rust's .unwrap()/.expect().
 * Returns T from T | null | undefined with type narrowing in one expression.
 *
 * @example
 * // assert needs two statements:
 * const user = db.findUser(id)
 * assert(user !== null, 'user not found:', id)
 *
 * // unwrap does it inline:
 * const user = unwrap(db.findUser(id), 'user not found:', id)
 * const el = unwrap(document.getElementById('app'))
 */
export declare function unwrap<T>(value: T | null | undefined, ...msg: any[]): T;
export declare const offensive: {
    Panic: typeof Panic;
    assert: typeof assert;
    panic: typeof panic;
    must: typeof must;
    unwrap: typeof unwrap;
};
//# sourceMappingURL=offensive.d.ts.map