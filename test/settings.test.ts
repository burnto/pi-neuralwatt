import { describe, expect, it } from "vitest";
import {
	DEFAULT_RATE_USD_PER_KWH,
	DEFAULT_SETTINGS,
	parseSettings,
} from "../lib.ts";

describe("parseSettings", () => {
	it("returns defaults for non-objects", () => {
		expect(parseSettings(undefined)).toEqual(DEFAULT_SETTINGS);
		expect(parseSettings(null)).toEqual(DEFAULT_SETTINGS);
		expect(parseSettings("nope")).toEqual(DEFAULT_SETTINGS);
		expect(parseSettings(42)).toEqual(DEFAULT_SETTINGS);
	});

	it("uses defaults for unknown values", () => {
		const settings = parseSettings({
			energyStatus: "sometimes",
			energyColor: "rainbow",
			equivalents: ["doomscroll", "nonsense"],
			fallbackRateUsdPerKwh: -1,
		});
		expect(settings.energyStatus).toBe(DEFAULT_SETTINGS.energyStatus);
		expect(settings.energyColor).toBe(DEFAULT_SETTINGS.energyColor);
		expect(settings.equivalents).toEqual(["doomscroll"]);
		expect(settings.fallbackRateUsdPerKwh).toBe(DEFAULT_RATE_USD_PER_KWH);
	});

	it("accepts valid values", () => {
		const settings = parseSettings({
			energyStatus: "both",
			energyColor: "accent",
			equivalents: ["brain", "led"],
			patchPiCost: false,
			perResponseLine: true,
			fallbackRateUsdPerKwh: 7.5,
		});
		expect(settings).toEqual({
			energyStatus: "both",
			energyColor: "accent",
			equivalents: ["brain", "led"],
			patchPiCost: false,
			perResponseLine: true,
			fallbackRateUsdPerKwh: 7.5,
		});
	});

	it("does not share the defaults array between calls", () => {
		const first = parseSettings({});
		first.equivalents.push("brain");
		expect(parseSettings({}).equivalents).toEqual([]);
	});
});
