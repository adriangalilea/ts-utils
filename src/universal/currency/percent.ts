// Percentage / basis-point arithmetic. Pure math, dataset-free.

export function percentageOf(value: number, total: number): number {
	if (total === 0) return 0;
	return (value / total) * 100;
}

export function percentageChange(oldValue: number, newValue: number): number {
	if (oldValue === 0) {
		if (newValue === 0) return 0;
		return newValue > 0 ? 100 : -100;
	}
	return ((newValue - oldValue) / Math.abs(oldValue)) * 100;
}

export function percentageDiff(a: number, b: number): number {
	if (a === 0 && b === 0) return 0;
	const avg = (Math.abs(a) + Math.abs(b)) / 2;
	if (avg === 0) return 0;
	return (Math.abs(a - b) / avg) * 100;
}

export function basisPointsToPercent(bps: number): number {
	return bps / 100.0;
}

export function percentToBasisPoints(percent: number): number {
	return Math.round(percent * 100);
}

export function formatBasisPoints(bps: number): string {
	return `${bps} bps`;
}
