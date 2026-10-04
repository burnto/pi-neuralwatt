import { describe, expect, it } from "vitest";
import {
	DEFAULT_PRESETS,
	DEFAULT_RATE_USD_PER_KWH,
	DEFAULT_SETTINGS,
	DEFAULT_TOGGLE_SHORTCUT,
	findPreset,
	isValidEquivalentPreset,
	isValidKeyId,
	isValidPresetId,
	parseSettings,
	resolveEffectiveRate,
	sanitizePresets,
} from "../lib.ts";

describe("parseSettings: defaults and legacy migration", () => {
	it("returns v2 defaults for non-objects", () => {
		for (const raw of [undefined, null, "nope", 42, []]) {
			const settings = parseSettings(raw);
			expect(settings.settingsVersion).toBe(2);
			expect(settings.energyUiEnabled).toBe(true);
			expect(settings.energyStatus).toBe("session");
			expect(settings.equivalentPresets).toEqual(DEFAULT_SETTINGS.equivalentPresets);
			expect(settings.toggleShortcut).toBe(DEFAULT_TOGGLE_SHORTCUT);
		}
	});

	it("folds legacy energyStatus off into the master switch", () => {
		const settings = parseSettings({ energyStatus: "off" });
		expect(settings.energyUiEnabled).toBe(false);
		expect(settings.energyStatus).toBe("session");
	});

	it("preserves legacy last/both modes and turns the master switch on", () => {
		expect(parseSettings({ energyStatus: "last" })).toMatchObject({
			energyUiEnabled: true,
			energyStatus: "last",
		});
		expect(parseSettings({ energyStatus: "both" })).toMatchObject({
			energyUiEnabled: true,
			energyStatus: "both",
		});
	});

	it("preserves explicit v2 settings", () => {
		const settings = parseSettings({
			settingsVersion: 2,
			energyUiEnabled: false,
			energyStatus: "last",
			toggleShortcut: null,
			equivalents: ["led"],
			fallbackRateUsdPerKwh: 7.5,
		});
		expect(settings.energyUiEnabled).toBe(false);
		expect(settings.energyStatus).toBe("last");
		expect(settings.toggleShortcut).toBeNull();
		expect(settings.equivalents).toEqual(["led"]);
		expect(settings.fallbackRateUsdPerKwh).toBe(7.5);
	});

	it("drops unknown values and the obsolete doomscroll preset", () => {
		const settings = parseSettings({
			energyStatus: "sometimes",
			energyColor: "rainbow",
			equivalents: ["doomscroll", "brain", "nonsense"],
			fallbackRateUsdPerKwh: -1,
		});
		expect(settings.energyStatus).toBe("session");
		expect(settings.energyColor).toBe(DEFAULT_SETTINGS.energyColor);
		// doomscroll no longer maps to a preset, so it is dropped without silently
		// switching the user to a kettle.
		expect(settings.equivalents).toEqual(["brain"]);
		expect(settings.fallbackRateUsdPerKwh).toBe(DEFAULT_RATE_USD_PER_KWH);
	});

	it("does not share default arrays between calls", () => {
		const first = parseSettings({});
		first.equivalents.push("brain");
		first.equivalentPresets.push({ id: "x", icon: "", label: "x", watts: 5 });
		expect(parseSettings({}).equivalents).toEqual([]);
		expect(parseSettings({}).equivalentPresets).toEqual(
			DEFAULT_SETTINGS.equivalentPresets,
		);
	});
});

describe("parseSettings: preset catalog", () => {
	it("uses defaults when equivalentPresets is absent", () => {
		expect(parseSettings({}).equivalentPresets).toEqual(DEFAULT_PRESETS);
	});

	it("keeps an intentionally empty catalog across a reload", () => {
		const settings = parseSettings({ equivalentPresets: [], equivalents: ["led"] });
		expect(settings.equivalentPresets).toEqual([]);
		// No preset with that id exists, so the enabled id is dropped too.
		expect(settings.equivalents).toEqual([]);
	});

	it("drops invalid presets and de-duplicates ids", () => {
		const settings = parseSettings({
			equivalentPresets: [
				{ id: "ok", icon: "", label: "Ok", watts: 5 },
				{ id: "ok", icon: "", label: "Dup", watts: 6 },
				{ id: "bad id!", icon: "", label: "Bad", watts: 5 },
				{ id: "neg", icon: "", label: "Neg", watts: -1 },
				{ id: "nl", icon: "", label: "two\nlines", watts: 5 },
				{ id: "esc", icon: "", label: "x\u001b[31m", watts: 5 },
			],
		});
		expect(settings.equivalentPresets).toHaveLength(1);
		expect(settings.equivalentPresets[0]).toEqual({
			id: "ok",
			icon: "",
			label: "Ok",
			watts: 5,
		});
	});

	it("preserves user-edited preset values", () => {
		const settings = parseSettings({
			equivalentPresets: [
				{ id: "fan", icon: "\u{1F300}", label: "Desk fan", watts: 45 },
			],
			equivalents: ["fan"],
		});
		expect(findPreset(settings.equivalentPresets, "fan")?.watts).toBe(45);
		expect(settings.equivalents).toEqual(["fan"]);
	});

	it("drops duplicate enabled ids", () => {
		expect(
			parseSettings({ equivalents: ["led", "led", "brain"] }).equivalents,
		).toEqual(["led", "brain"]);
	});
});

describe("preset validation", () => {
	it("validates ids", () => {
		expect(isValidPresetId("led")).toBe(true);
		expect(isValidPresetId("my-preset_2")).toBe(true);
		expect(isValidPresetId("-bad")).toBe(false);
		expect(isValidPresetId("has space")).toBe(false);
		expect(isValidPresetId("")).toBe(false);
		expect(isValidPresetId(5)).toBe(false);
	});

	it("validates preset shapes", () => {
		expect(
			isValidEquivalentPreset({ id: "led", icon: "", label: "LED", watts: 10 }),
		).toBe(true);
		expect(
			isValidEquivalentPreset({ id: "led", icon: "", label: "", watts: 10 }),
		).toBe(false);
		expect(
			isValidEquivalentPreset({ id: "led", icon: "", label: "LED", watts: 0 }),
		).toBe(false);
		expect(
			isValidEquivalentPreset({ id: "led", icon: "", label: "a\u0007b", watts: 10 }),
		).toBe(false);
	});

	it("returns undefined for a non-array catalog", () => {
		expect(sanitizePresets("nope")).toBeUndefined();
		expect(sanitizePresets(undefined)).toBeUndefined();
	});
});

describe("resolveEffectiveRate", () => {
	it("prefers a valid environment value", () => {
		expect(resolveEffectiveRate({ fallbackRateUsdPerKwh: 10 }, "7.5")).toEqual({
			rateUsdPerKwh: 7.5,
			source: "environment",
		});
	});
	it("falls back to the saved setting for invalid environment values", () => {
		for (const env of [undefined, "", "abc", "0", "-1", "NaN"]) {
			expect(resolveEffectiveRate({ fallbackRateUsdPerKwh: 9 }, env)).toEqual({
				rateUsdPerKwh: 9,
				source: "settings",
			});
		}
	});
});

describe("isValidKeyId", () => {
	it("accepts Pi key syntax", () => {
		expect(isValidKeyId("ctrl+shift+e")).toBe(true);
		expect(isValidKeyId("alt+e")).toBe(true);
		expect(isValidKeyId("f5")).toBe(true);
		expect(isValidKeyId("ctrl+alt+delete")).toBe(true);
		expect(isValidKeyId("escape")).toBe(true);
	});
	it("rejects malformed bindings", () => {
		expect(isValidKeyId("")).toBe(false);
		expect(isValidKeyId("hyper+e")).toBe(false);
		expect(isValidKeyId("ctrl+")).toBe(false);
		expect(isValidKeyId("ctrl+ctrl+e")).toBe(false);
		expect(isValidKeyId("ctrl+shift")).toBe(false);
		expect(isValidKeyId(5)).toBe(false);
	});
});
