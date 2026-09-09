/** Product measurement with declared keys and bounded dimensions. No runtime or store dependency. */
export type MetricSpec = {
	kind: "counter" | "timing";
	label: string;
	help?: string;
	unit?: string;
	perUser?: boolean;
	dimensions?: Record<string, readonly string[]>;
};

export interface Measurement {
	key: string;
	day: string;
	count: number;
	sum: number;
	user?: string | number;
	dimensions: Record<string, string>;
}

export interface MetricsSchema {
	metrics: Array<{ key: string } & MetricSpec>;
	overlaps: Array<{ from: string; to: string }>;
}

/**
 * Where measurements go. `declare` runs once per process before the first write and
 * carries the whole schema (kinds, labels, per-user flags, overlaps), so a store is
 * self-describing and a reader never needs the declaring code. `write` carries one sample.
 */
export interface MetricsStore {
	declare(schema: MetricsSchema): Promise<unknown>;
	write(measurement: Measurement): Promise<unknown>;
}

export interface MetricsOptions<Keys extends string = string> {
	store: MetricsStore;
	/** Unordered user overlap, not an ordered conversion funnel. */
	overlaps?: ReadonlyArray<readonly [Keys, Keys]>;
	/** Failures are visible by default, but never reject a measurement call. */
	onError?: (error: unknown, key: string) => void;
	now?: () => Date;
}

export interface SampleOptions {
	user?: string | number;
	dimensions?: Record<string, string>;
}
export interface CounterHandle {
	bump(options?: SampleOptions & { n?: number }): Promise<void>;
}
export interface TimingHandle {
	record(value: number, options?: SampleOptions): Promise<void>;
}
export type Metrics<Spec extends Record<string, MetricSpec>> = {
	[K in keyof Spec]: Spec[K]["kind"] extends "counter"
		? CounterHandle
		: TimingHandle;
} & {
	describe(): MetricsSchema;
	/**
	 * Declare now instead of at the first sample: a server's boot, a Worker's cron. The
	 * same once-per-process promise the samples await, so calling it is never a second write.
	 */
	declare(): Promise<void>;
};

const identifier = /^[a-zA-Z][a-zA-Z0-9_]*$/;

export function defineMetrics<const Spec extends Record<string, MetricSpec>>(
	input: Spec,
	opts: MetricsOptions<Extract<keyof Spec, string>>,
): Metrics<Spec> {
	// Snapshot declarations: later caller mutations cannot change validation or labels.
	const spec = structuredClone(input);
	for (const [key, s] of Object.entries(spec)) {
		if (
			!identifier.test(key) ||
			key === "describe" ||
			key === "declare" ||
			key === "constructor" ||
			key === "prototype"
		)
			throw new Error(`metrics: invalid or reserved key "${key}"`);
		if (!s.label.trim() || !["counter", "timing"].includes(s.kind))
			throw new Error(`metrics: invalid declaration "${key}"`);
		for (const [name, values] of Object.entries(s.dimensions ?? {})) {
			if (
				!identifier.test(name) ||
				!values.length ||
				new Set(values).size !== values.length ||
				values.some((v) => typeof v !== "string" || !v.length || v.length > 128)
			)
				throw new Error(`metrics: invalid dimension "${key}.${name}"`);
		}
	}
	const overlaps = (opts.overlaps ?? []).map(([from, to]) => {
		if (!spec[from]?.perUser || !spec[to]?.perUser)
			throw new Error("metrics: overlap requires two declared perUser metrics");
		return { from, to };
	});
	const describe = (): MetricsSchema =>
		structuredClone({
			metrics: Object.entries(spec).map(([key, s]) => ({ key, ...s })),
			overlaps,
		});
	const report =
		opts.onError ??
		((_error: unknown, key: string) =>
			console.warn(`metrics: measurement failed (${key})`));
	// The schema reaches the store once per process, ahead of the first sample. A failed
	// declaration is retried by the next sample, so a store that was briefly away recovers
	// and a store that refuses the schema (a changed kind) fails every sample, loudly.
	let declared: Promise<unknown> | undefined;
	const declare = () => {
		declared ??= opts.store.declare(describe()).catch((error) => {
			declared = undefined;
			throw error;
		});
		return declared;
	};
	async function write(
		key: string,
		count: number,
		sum: number,
		options?: SampleOptions,
	) {
		try {
			if (
				!Number.isSafeInteger(count) ||
				count <= 0 ||
				!Number.isFinite(sum) ||
				sum < 0
			)
				throw new Error(
					"metrics: samples must be finite and nonnegative; counts must be positive safe integers",
				);
			const s = spec[key];
			const supplied = options?.dimensions ?? {};
			const dimensions: Record<string, string> = {};
			if (
				Object.keys(supplied).length !== Object.keys(s.dimensions ?? {}).length
			)
				throw new Error("metrics: unexpected or missing dimensions");
			for (const name of Object.keys(s.dimensions ?? {}).sort()) {
				const value = supplied[name];
				if (!s.dimensions?.[name].includes(value))
					throw new Error(`metrics: invalid dimension ${name}`);
				dimensions[name] = value;
			}
			const user = s.perUser ? options?.user : undefined;
			if (
				user !== undefined &&
				(typeof user === "number"
					? !Number.isSafeInteger(user)
					: typeof user !== "string" || !user.length || user.length > 128)
			)
				throw new Error("metrics: invalid user identifier");
			await declare();
			await opts.store.write({
				key,
				day: (opts.now?.() ?? new Date()).toISOString().slice(0, 10),
				count,
				sum,
				user,
				dimensions,
			});
		} catch (error) {
			try {
				report(error, key);
			} catch {
				/* Instrumentation must not break its caller. */
			}
		}
	}
	const out: Record<string, CounterHandle | TimingHandle> = {};
	for (const [key, s] of Object.entries(spec)) {
		out[key] =
			s.kind === "counter"
				? { bump: (o) => write(key, o?.n ?? 1, 0, o) }
				: { record: (value, o) => write(key, 1, value, o) };
	}
	return {
		...out,
		describe,
		declare: async () => {
			await declare();
		},
	} as Metrics<Spec>;
}
