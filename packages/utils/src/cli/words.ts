/**
 * `cli/words`: the word a person meant, for every "did you mean" a program
 * says (a command, a flag, an argument's choice, an action).
 */

/** The edits from `a` to `b`: a letter added, dropped or changed, or two
 *  neighbours swapped (`sned` → `send` is one edit, as a hand makes it). */
export function distance(a: string, b: string): number {
	const d = Array.from({ length: a.length + 1 }, (_, i) =>
		Array.from({ length: b.length + 1 }, (_, j) =>
			i === 0 ? j : j === 0 ? i : 0,
		),
	);
	for (let i = 1; i <= a.length; i++)
		for (let j = 1; j <= b.length; j++) {
			const row = d[i] as number[];
			const up = d[i - 1] as number[];
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			row[j] = Math.min(
				(up[j] as number) + 1,
				(row[j - 1] as number) + 1,
				(up[j - 1] as number) + cost,
			);
			if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1])
				row[j] = Math.min(
					row[j] as number,
					((d[i - 2] as number[])[j - 2] as number) + 1,
				);
		}
	return (d[a.length] as number[])[b.length] as number;
}

/** The word meant, where one is near enough to be a slip: one edit for a word of
 *  four letters or fewer, two for a longer one. A guess further off is noise
 *  (`-x` is two edits from `--on`). */
export const nearest = (word: string, among: readonly string[]) =>
	among
		.map((w) => [w, distance(word, w)] as const)
		.filter(([, d]) => d <= (word.length <= 4 ? 1 : 2))
		.sort((a, b) => a[1] - b[1])[0]?.[0];
