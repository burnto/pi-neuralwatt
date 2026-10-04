import { describe, expect, it } from "vitest";
import {
	DEFAULT_PRESETS,
	DEFAULT_SETTINGS,
	type EquivalentPreset,
	type ResponseTelemetry,
	type Totals,
	emptyTotals,
	findPreset,
	formatDurationSeconds,
	formatEquivalent,
	formatEquivalentDetail,
	formatJoules,
	formatStatusText,
	formatUsd,
	formatWh,
	equivalentSeconds,
	truncateVisible,
	visibleWidth,
} from "../lib.ts";

const preset = (overrides: Partial<EquivalentPreset> = {}): EquivalentPreset => ({
	id: "test",
	icon: "\u{1F50C}",
	label: "Test load",
	watts: 10,
	...overrides,
});

describe("formatUsd", () => {
	it("formats normal values with 2 decimals", () => {
		expect(formatUsd(1.234)).toBe("$1.23");
		expect(formatUsd(12)).toBe("$12.00");
	});
	it("formats sub-cent values with 5 decimals", () => {
		expect(formatUsd(0.001)).toBe("$0.00100");
		expect(formatUsd(0.01)).toBe("$0.01");
	});
	it("collapses sub-0.00001 positive values", () => {
		expect(formatUsd(0.000001)).toBe("<$0.00001");
	});
	it("handles zero", () => {
		expect(formatUsd(0)).toBe("$0.00000");
	});
});

describe("formatWh / formatJoules", () => {
	it("formats Wh and sub-Wh", () => {
		expect(formatWh(0.001)).toBe("1.00 Wh");
		expect(formatWh(0.0005)).toBe("0.500 Wh");
		expect(formatWh(0.0000001)).toBe("0.100 mWh");
		expect(formatWh(0)).toBe("0 Wh");
	});
	it("formats joules", () => {
		expect(formatJoules(151.91)).toBe("151.91 J");
		expect(formatJoules(360_000)).toBe("360.00 kJ");
	});
});

describe("formatDurationSeconds", () => {
	it("never renders a positive sub-second value as zero", () => {
		expect(formatDurationSeconds(0.4)).toBe("<1s");
		expect(formatDurationSeconds(0.0001)).toBe("<1s");
		expect(formatDurationSeconds(0)).toBe("0s");
		expect(formatDurationSeconds(-1)).toBe("0s");
	});
	it("formats seconds, minutes, and hours", () => {
		expect(formatDurationSeconds(1)).toBe("1s");
		expect(formatDurationSeconds(35)).toBe("35s");
		expect(formatDurationSeconds(90)).toBe("1m30");
		expect(formatDurationSeconds(120)).toBe("2m");
		expect(formatDurationSeconds(7800)).toBe("2h10");
		expect(formatDurationSeconds(7200)).toBe("2h");
	});
	it("supports spaced form", () => {
		expect(formatDurationSeconds(90, "spaced")).toBe("1m 30s");
		expect(formatDurationSeconds(7800, "spaced")).toBe("2h 10m");
	});
});

describe("equivalentSeconds", () => {
	it("uses a constant-power duration model", () => {
		// 1 Wh at 10 W = 360 s; at 20 W = 180 s; at 1500 W = 2.4 s.
		expect(equivalentSeconds(0.001, 10)).toBeCloseTo(360, 6);
		expect(equivalentSeconds(0.001, 20)).toBeCloseTo(180, 6);
		expect(equivalentSeconds(0.001, 1500)).toBeCloseTo(2.4, 6);
		// 1 kWh at 1000 W = 3600 s.
		expect(equivalentSeconds(1, 1000)).toBeCloseTo(3600, 6);
	});
	it("rejects invalid input", () => {
		expect(equivalentSeconds(-1, 10)).toBeUndefined();
		expect(equivalentSeconds(0.001, 0)).toBeUndefined();
	});
});

describe("formatEquivalent / formatEquivalentDetail", () => {
	it("matches the documented defaults at 1 Wh", () => {
		expect(formatEquivalent(0.001, findPreset(DEFAULT_PRESETS, "brain")!)).toBe(
			"\u{1F9E0} 3m",
		);
		expect(formatEquivalent(0.001, findPreset(DEFAULT_PRESETS, "led")!)).toBe(
			"\u{1F4A1} 6m",
		);
		expect(formatEquivalent(0.001, findPreset(DEFAULT_PRESETS, "kettle")!)).toBe(
			"\u{1FAD6} 2s",
		);
	});
	it("spells out the activity", () => {
		expect(formatEquivalentDetail(0.001, findPreset(DEFAULT_PRESETS, "brain")!)).toBe(
			"\u{1F9E0} 3m Human brain",
		);
	});
	it("returns undefined for invalid energy or power", () => {
		expect(formatEquivalent(-1, preset())).toBeUndefined();
		expect(formatEquivalent(0.001, preset({ watts: -1 }))).toBeUndefined();
	});
	it("omits an empty icon without leaving a leading space", () => {
		expect(formatEquivalent(0.001, preset({ icon: "" }))).toBe("6m");
	});
});

describe("formatStatusText", () => {
	const totals: Totals = {
		...emptyTotals(),
		responses: 2,
		energyKwh: 0.001,
		energyJoules: 3600,
		energyReported: 2,
		costUsd: 0.01,
		reportedCostUsd: 0.01,
		reportedCostResponses: 2,
	};
	const last: ResponseTelemetry = {
		schemaVersion: 2,
		provider: "neuralwatt",
		kind: "response-telemetry",
		modelId: "m",
		recordedAt: "2026-01-01T00:00:00.000Z",
		energy: { status: "reported", kwh: 0.0005 },
		cost: { status: "reported", usd: 0.005 },
	};

	it("shows the session total by default", () => {
		expect(formatStatusText(totals, last, DEFAULT_SETTINGS)).toBe(
			"\u26A1\uFE0F 1.00 Wh",
		);
	});

	it("distinguishes no reported data from a reported zero", () => {
		expect(formatStatusText(emptyTotals(), undefined, DEFAULT_SETTINGS)).toBe(
			"\u26A1\uFE0F no data",
		);
		const zeroTotals = { ...emptyTotals(), responses: 1, energyReported: 1 };
		expect(formatStatusText(zeroTotals, undefined, DEFAULT_SETTINGS)).toBe(
			"\u26A1\uFE0F 0 Wh",
		);
	});

	it("supports last and both modes", () => {
		expect(
			formatStatusText(totals, last, { ...DEFAULT_SETTINGS, energyStatus: "last" }),
		).toBe("\u26A1\uFE0F 0.500 Wh");
		expect(
			formatStatusText(totals, last, { ...DEFAULT_SETTINGS, energyStatus: "both" }),
		).toBe("\u26A1\uFE0F 1.00 Wh (+0.500 Wh)");
	});

	it("hides when the master switch is off", () => {
		expect(
			formatStatusText(totals, last, { ...DEFAULT_SETTINGS, energyUiEnabled: false }),
		).toBeUndefined();
	});

	it("appends enabled equivalents", () => {
		expect(
			formatStatusText(totals, last, {
				...DEFAULT_SETTINGS,
				equivalents: ["led"],
			}),
		).toBe("\u26A1\uFE0F 1.00 Wh \u00B7 \u{1F4A1} 6m");
	});

	it("ignores enabled ids with no matching preset", () => {
		expect(
			formatStatusText(totals, last, {
				...DEFAULT_SETTINGS,
				equivalents: ["ghost"],
			}),
		).toBe("\u26A1\uFE0F 1.00 Wh");
	});
});

describe("visibleWidth / truncateVisible", () => {
	it("counts emoji as two cells and combining marks as zero", () => {
		expect(visibleWidth("abc")).toBe(3);
		expect(visibleWidth("\u{1F9E0}")).toBe(2);
		expect(visibleWidth("e\u0301")).toBe(1);
	});

	it("returns text unchanged when it fits", () => {
		expect(truncateVisible("abc", 3)).toBe("abc");
		expect(truncateVisible("abc", 10)).toBe("abc");
	});

	it("truncates with an ellipsis within the width", () => {
		expect(truncateVisible("abc", 2)).toBe("a\u2026");
		expect(visibleWidth(truncateVisible("abc", 2))).toBeLessThanOrEqual(2);
	});

	it("respects wide graphemes", () => {
		const out = truncateVisible("\u{1F9E0}abc", 3);
		expect(visibleWidth(out)).toBeLessThanOrEqual(3);
		expect(out.startsWith("\u{1F9E0}")).toBe(true);
	});

	it("handles a zero width", () => {
		expect(truncateVisible("abc", 0)).toBe("");
	});
});
