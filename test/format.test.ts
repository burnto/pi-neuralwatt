import { describe, expect, it } from "vitest";
import {
	DEFAULT_SETTINGS,
	type EnergyCostEntry,
	type Totals,
	emptyTotals,
	formatCompactDuration,
	formatEquivalent,
	formatEquivalentDetail,
	formatJoules,
	formatSpacedDuration,
	formatStatusText,
	formatUsd,
	formatWh,
} from "../lib.ts";

describe("formatUsd", () => {
	it("formats normal values with 2 decimals", () => {
		expect(formatUsd(1.234)).toBe("$1.23");
		expect(formatUsd(12)).toBe("$12.00");
		expect(formatUsd(0.5)).toBe("$0.50");
	});

	it("formats sub-cent values with 5 decimals", () => {
		expect(formatUsd(0.001)).toBe("$0.00100");
		expect(formatUsd(0.009)).toBe("$0.00900");
		expect(formatUsd(0.01)).toBe("$0.01");
	});

	it("collapses sub-0.00001 positive values to <$0.00001", () => {
		expect(formatUsd(0.000001)).toBe("<$0.00001");
		expect(formatUsd(0.0000001)).toBe("<$0.00001");
	});

	it("handles zero", () => {
		expect(formatUsd(0)).toBe("$0.00000");
	});

	it("handles large values", () => {
		expect(formatUsd(1234.5)).toBe("$1234.50");
	});
});

describe("formatWh", () => {
	it("formats >= 1 Wh with 2 decimals", () => {
		expect(formatWh(0.001)).toBe("1.00 Wh");
		expect(formatWh(0.05)).toBe("50.00 Wh");
		expect(formatWh(1)).toBe("1000.00 Wh");
	});

	it("formats sub-Wh values (>= 0.001 Wh) with 3 decimals", () => {
		expect(formatWh(0.0005)).toBe("0.500 Wh");
		expect(formatWh(0.000001)).toBe("0.001 Wh");
	});

	it("formats sub-mWh positive values as mWh with 3 decimals", () => {
		expect(formatWh(0.0000001)).toBe("0.100 mWh");
		expect(formatWh(1e-9)).toBe("0.001 mWh");
	});

	it("formats zero without decimals", () => {
		expect(formatWh(0)).toBe("0 Wh");
	});
});

describe("formatJoules", () => {
	it("formats small values in joules", () => {
		expect(formatJoules(151.91)).toBe("151.91 J");
	});
	it("formats large values in kilojoules", () => {
		expect(formatJoules(360_000)).toBe("360.00 kJ");
		expect(formatJoules(1000)).toBe("1.00 kJ");
	});
});

describe("formatCompactDuration", () => {
	it("formats sub-minute durations as seconds", () => {
		expect(formatCompactDuration(35 / 60)).toBe("35s");
		expect(formatCompactDuration(0.5)).toBe("30s");
	});
	it("formats minutes with a two-digit seconds suffix", () => {
		expect(formatCompactDuration(1.5)).toBe("1m30");
		expect(formatCompactDuration(1)).toBe("1m");
	});
	it("formats hours with a two-digit minutes suffix", () => {
		expect(formatCompactDuration(130)).toBe("2h10");
		expect(formatCompactDuration(120)).toBe("2h");
	});
	it("handles zero and invalid input", () => {
		expect(formatCompactDuration(0)).toBe("0s");
		expect(formatCompactDuration(-1)).toBe("0s");
		expect(formatCompactDuration(NaN)).toBe("0s");
	});
});

describe("formatSpacedDuration", () => {
	it("joins units with a space", () => {
		expect(formatSpacedDuration(1.5)).toBe("1m 30s");
		expect(formatSpacedDuration(130)).toBe("2h 10m");
		expect(formatSpacedDuration(35 / 60)).toBe("35s");
		expect(formatSpacedDuration(120)).toBe("2h");
	});
});

describe("formatEquivalent", () => {
	it("converts kWh into an icon and compact duration", () => {
		// 416 mWh/min -> 1 Wh is ~2.4 min of doomscrolling
		expect(formatEquivalent(0.001, "doomscroll")).toBe("\u{1F4F1} 2m24");
		expect(formatEquivalent(0.001, "brain")).toBe("\u{1F9E0} 3m");
	});
	it("returns undefined for unknown ids or invalid energy", () => {
		expect(formatEquivalent(0.001, "nope" as never)).toBeUndefined();
		expect(formatEquivalent(-1, "doomscroll")).toBeUndefined();
	});
});

describe("formatEquivalentDetail", () => {
	it("spells out the activity for the slash command", () => {
		expect(formatEquivalentDetail(0.001, "doomscroll")).toBe(
			"\u{1F4F1} 2m 24s doomscrolling on an iPhone 15",
		);
		expect(formatEquivalentDetail(0.001, "brain")).toBe(
			"\u{1F9E0} 3m powering a human brain",
		);
	});
	it("returns undefined for invalid energy", () => {
		expect(formatEquivalentDetail(-1, "brain")).toBeUndefined();
	});
});

describe("formatStatusText", () => {
	const totals: Totals = {
		...emptyTotals(),
		requests: 2,
		energyKwh: 0.001,
		energyJoules: 3600,
		costUsd: 0.01,
		reportedCostRequests: 2,
	};
	const last: EnergyCostEntry = {
		provider: "neuralwatt",
		kind: "response-energy",
		energyKwh: 0.0005,
		costUsd: 0.005,
		costSource: "reported",
		accountingMethod: "energy",
		measuredAt: "2026-01-01T00:00:00.000Z",
	};

	it("shows the session total by default", () => {
		expect(formatStatusText(totals, last, DEFAULT_SETTINGS)).toBe("\u26A1\uFE0E1.00 Wh");
	});

	it("shows zero before any measurements", () => {
		expect(formatStatusText(emptyTotals(), undefined, DEFAULT_SETTINGS)).toBe(
			"\u26A1\uFE0E0 Wh",
		);
	});

	it("supports last-response and combined modes", () => {
		expect(
			formatStatusText(totals, last, { ...DEFAULT_SETTINGS, energyStatus: "last" }),
		).toBe("\u26A1\uFE0E0.500 Wh");
		expect(
			formatStatusText(totals, last, { ...DEFAULT_SETTINGS, energyStatus: "both" }),
		).toBe("\u26A1\uFE0E1.00 Wh (+0.500 Wh)");
	});

	it("hides when disabled", () => {
		expect(
			formatStatusText(totals, last, { ...DEFAULT_SETTINGS, energyStatus: "off" }),
		).toBeUndefined();
	});

	it("appends configured equivalents to the session total", () => {
		expect(
			formatStatusText(totals, last, { ...DEFAULT_SETTINGS, equivalents: ["doomscroll"] }),
		).toBe("\u26A1\uFE0E1.00 Wh \u00B7 2.4 min doomscrolling");
	});
});
