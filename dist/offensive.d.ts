/**
 * Offensive programming primitives + typed boundary errors.
 *
 * "A confused program SHOULD scream." — John Carmack
 *
 * Throw, always. An uncaught Panic crashes the process with a full stack trace.
 * Zero dependencies. Works identically in Node, Deno, Bun, and browsers.
 *
 * Fail-fast primitives (throw Panic — bugs in us):
 *   assert(cond, ...msg)          invariant checking, narrows types via `asserts`
 *   panic(...msg)                 impossible state reached
 *   assertNever(value, ...msg)    exhaustiveness check — compile error on missed cases
 *   must(() => expr)              unwrap-or-die for operations (sync + async)
 *   unwrap(value, ...msg)         unwrap nullable T | null | undefined → T
 *
 * Typed boundary errors (throw SourcedError — the external system failed):
 *   SourcedError                  typed error with source/operation/status/context
 *   isSourcedError(e, source?)    type guard for catch-site narrowing
 *
 * Panics are bugs. SourcedErrors are boundary failures. Keep them separate at
 * catch boundaries:
 *
 *   try { await doWork() }
 *   catch (e) {
 *     if (e instanceof Panic) throw e            // bug in us — crash
 *     if (isSourcedError(e, 'stripe')) { ... }   // stripe failed — handle
 *     throw e                                    // unknown — re-throw
 *   }
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
 * Exhaustiveness check — compile error if a switch/if misses a case.
 * The `never` type means TS won't let you call this if all cases are handled.
 * Add a new variant to a union → every assertNever site lights up at compile time.
 *
 * @example
 * type Event = { kind: 'click' } | { kind: 'hover' } | { kind: 'scroll' }
 * function handle(e: Event) {
 *   switch (e.kind) {
 *     case 'click': return handleClick()
 *     case 'hover': return handleHover()
 *     // forgot 'scroll' → TS error: Argument of type '{ kind: "scroll" }' not assignable to 'never'
 *     default: assertNever(e)
 *   }
 * }
 */
export declare function assertNever(value: never, ...msg: any[]): never;
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
/**
 * Typed error from a named external source with structured context.
 *
 * Raise at boundaries with the messy world (HTTP APIs, databases, external
 * processes). Every SourcedError carries enough context to reconstruct the
 * failure without a debugger.
 *
 * @example
 * try {
 *   return await stripe.charges.create({ customer, amount })
 * } catch (e) {
 *   throw new SourcedError({
 *     source: 'stripe',
 *     operation: 'charge_customer',
 *     message: e instanceof Error ? e.message : String(e),
 *     status: (e as any)?.statusCode,
 *     cause: e,
 *     context: { customer, amount },
 *   })
 * }
 */
export declare class SourcedError<S extends string = string> extends Error {
    readonly source: S;
    readonly operation: string;
    readonly status?: number;
    readonly context: Record<string, unknown>;
    constructor(args: {
        source: S;
        operation: string;
        message: string;
        status?: number;
        cause?: unknown;
        context?: Record<string, unknown>;
    });
    toJSON(): Record<string, unknown>;
}
/**
 * Type guard for SourcedError. Optionally narrows to a specific source.
 *
 * @example
 * try { await charge(customer, amount) }
 * catch (e) {
 *   if (isSourcedError(e, 'stripe') && e.status === 402) {
 *     // TS knows e.source === 'stripe' here
 *     return 'card declined'
 *   }
 *   throw e
 * }
 */
export declare function isSourcedError<S extends string>(e: unknown, source?: S): e is SourcedError<S>;
export declare const offensive: {
    Panic: typeof Panic;
    assert: typeof assert;
    panic: typeof panic;
    assertNever: typeof assertNever;
    must: typeof must;
    unwrap: typeof unwrap;
    SourcedError: typeof SourcedError;
    isSourcedError: typeof isSourcedError;
};
//# sourceMappingURL=offensive.d.ts.map