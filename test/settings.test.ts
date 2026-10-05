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
	it("returns v3 defaults for non-objects", () => {
		for (const raw of [undefined, null, "nope", 42, []]) {
			const settings = parseSettings(raw);
			expect(settings.settingsVersion).toBe(3);
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
		expect(settings.settingsVersion).toBe(3);
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
		// doomscroll no longer maps to a preset, so it is dropped without
		// substituting another preset.
		expect(settings.equivalents).toEqual(["brain"]);
		expect(settings.fallbackRateUsdPerKwh).toBe(DEFAULT_RATE_USD_PER_KWH);
	});

	it("does not share default arrays between calls", () => {
		const first = parseSettings({});
		first.equivalents.push("brain");
		first.equivalentPresets.push({
			kind: "power",
			id: "x",
			icon: "",
			label: "x",
			watts: 5,
		});
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
		expect(settings.equivalentPresets).toEqual([
			{ kind: "power", id: "ok", icon: "", label: "Ok", watts: 5 },
		]);
	});

	it("preserves user-edited preset values", () => {
		const settings = parseSettings({
			equivalentPresets: [
				{ id: "fan", icon: "\u{1F300}", label: "Desk fan", watts: 45 },
			],
			equivalents: ["fan"],
		});
		const fan = findPreset(settings.equivalentPresets, "fan");
		expect(fan?.kind === "power" ? fan.watts : undefined).toBe(45);
		expect(settings.equivalents).toEqual(["fan"]);
	});

	it("drops duplicate enabled ids", () => {
		expect(
			parseSettings({ equivalents: ["led", "led", "brain"] }).equivalents,
		).toEqual(["led", "brain"]);
	});
});

describe("parseSettings: version migration and unit presets", () => {
	it("always reports settingsVersion 3", () => {
		expect(parseSettings({ settingsVersion: 2 }).settingsVersion).toBe(3);
		expect(parseSettings(undefined).settingsVersion).toBe(3);
	});

	it("normalizes a v2 preset without kind to power", () => {
		const settings = parseSettings({
			settingsVersion: 2,
			equivalentPresets: [
				{ id: "fan", icon: "\u{1F300}", label: "Desk fan", watts: 45 },
			],
			equivalents: ["fan"],
		});
		expect(settings.equivalentPresets).toEqual([
			{
				kind: "power",
				id: "fan",
				icon: "\u{1F300}",
				label: "Desk fan",
				watts: 45,
			},
		]);
		expect(settings.equivalents).toEqual(["fan"]);
	});

	it("round-trips a v3 unit preset", () => {
		const preset = {
			kind: "unit",
			id: "bags",
			icon: "\u{1F6CD}\uFE0F",
			label: "Plastic bags",
			perKwh: 10,
			unit: "plastic bags",
		};
		const settings = parseSettings({
			settingsVersion: 3,
			equivalentPresets: [preset],
			equivalents: ["bags"],
		});
		expect(settings.equivalentPresets).toEqual([preset]);
		expect(settings.equivalents).toEqual(["bags"]);
	});

	it("drops unit presets with unusable fields", () => {
		const settings = parseSettings({
			equivalentPresets: [
				{ kind: "unit", id: "a", icon: "", label: "A", perKwh: 0, unit: "x" },
				{ kind: "unit", id: "b", icon: "", label: "B", perKwh: 10, unit: "" },
				{ kind: "unit", id: "c", icon: "", label: "C", perKwh: 10 },
				{
					kind: "unit",
					id: "d",
					icon: "",
					label: "D",
					perKwh: 10,
					unit: "two\nlines",
				},
				{ kind: "unit", id: "e", icon: "", label: "E", perKwh: 10, unit: "ok" },
			],
		});
		expect(settings.equivalentPresets.map((preset) => preset.id)).toEqual(["e"]);
	});

	it("does not infer the unit kind when kind is absent", () => {
		const settings = parseSettings({
			equivalentPresets: [
				{ id: "q", icon: "", label: "Q", perKwh: 10, unit: "widgets" },
			],
		});
		expect(settings.equivalentPresets).toEqual([]);
	});

	it("prefers an explicit kind over conflicting fields", () => {
		const settings = parseSettings({
			equivalentPresets: [
				{
					kind: "unit",
					id: "u",
					icon: "",
					label: "U",
					perKwh: 10,
					unit: "u",
					watts: 99,
				},
				{
					kind: "power",
					id: "p",
					icon: "",
					label: "P",
					watts: 99,
					perKwh: 10,
					unit: "u",
				},
			],
		});
		expect(settings.equivalentPresets).toEqual([
			{ kind: "unit", id: "u", icon: "", label: "U", perKwh: 10, unit: "u" },
			{ kind: "power", id: "p", icon: "", label: "P", watts: 99 },
		]);
	});

	it("normalizes a mixed preset without kind to power", () => {
		const settings = parseSettings({
			equivalentPresets: [
				{ id: "m", icon: "", label: "M", watts: 99, perKwh: 10, unit: "u" },
			],
		});
		expect(settings.equivalentPresets).toEqual([
			{ kind: "power", id: "m", icon: "", label: "M", watts: 99 },
		]);
	});

	it("de-duplicates ids across kinds, keeping the first", () => {
		const settings = parseSettings({
			equivalentPresets: [
				{ kind: "power", id: "dup", icon: "", label: "First", watts: 5 },
				{
					kind: "unit",
					id: "dup",
					icon: "",
					label: "Second",
					perKwh: 10,
					unit: "x",
				},
			],
		});
		expect(settings.equivalentPresets).toEqual([
			{ kind: "power", id: "dup", icon: "", label: "First", watts: 5 },
		]);
	});

	it("drops an unknown kind without substituting one", () => {
		const settings = parseSettings({
			equivalentPresets: [
				{ kind: "watts", id: "x", icon: "", label: "X", watts: 10 },
			],
		});
		expect(settings.equivalentPresets).toEqual([]);
	});

	it("defaults to brain, led, and the unit calories and cookies presets", () => {
		const ids = parseSettings({}).equivalentPresets.map((preset) => preset.id);
		expect(ids).toEqual(["brain", "led", "calories", "cookies"]);
		expect(findPreset(DEFAULT_PRESETS, "calories")).toEqual({
			kind: "unit",
			id: "calories",
			icon: "\u{1F355}",
			label: "Food calories",
			perKwh: 860.42,
			unit: "calories",
		});
		expect(findPreset(DEFAULT_PRESETS, "cookies")).toEqual({
			kind: "unit",
			id: "cookies",
			icon: "\u{1F36A}",
			label: "Chocolate chip cookies",
			perKwh: 860.42 / 150,
			unit: "cookies",
		});
	});

	it("drops a removed default kettle id when the catalog lacks it", () => {
		const settings = parseSettings({
			equivalents: ["kettle", "led"],
			equivalentPresets: [
				{ kind: "power", id: "led", icon: "\u{1F4A1}", label: "LED", watts: 10 },
			],
		});
		expect(settings.equivalents).toEqual(["led"]);
	});

	it("preserves a custom legacy power preset rather than deleting it", () => {
		const settings = parseSettings({
			equivalents: ["kettle"],
			equivalentPresets: [
				{ id: "kettle", icon: "\u{1FAD6}", label: "My kettle", watts: 1200 },
			],
		});
		expect(findPreset(settings.equivalentPresets, "kettle")).toEqual({
			kind: "power",
			id: "kettle",
			icon: "\u{1FAD6}",
			label: "My kettle",
			watts: 1200,
		});
		expect(settings.equivalents).toEqual(["kettle"]);
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
			isValidEquivalentPreset({
				kind: "power",
				id: "led",
				icon: "",
				label: "LED",
				watts: 10,
			}),
		).toBe(true);
		expect(
			isValidEquivalentPreset({
				kind: "unit",
				id: "bags",
				icon: "",
				label: "Bags",
				perKwh: 10,
				unit: "plastic bags",
			}),
		).toBe(true);
		// An absent kind is not a valid discriminated shape.
		expect(
			isValidEquivalentPreset({ id: "led", icon: "", label: "LED", watts: 10 }),
		).toBe(false);
		expect(
			isValidEquivalentPreset({
				kind: "power",
				id: "led",
				icon: "",
				label: "",
				watts: 10,
			}),
		).toBe(false);
		expect(
			isValidEquivalentPreset({
				kind: "power",
				id: "led",
				icon: "",
				label: "LED",
				watts: 0,
			}),
		).toBe(false);
		expect(
			isValidEquivalentPreset({
				kind: "power",
				id: "led",
				icon: "",
				label: "a\u0007b",
				watts: 10,
			}),
		).toBe(false);
		// Unit presets need a positive perKwh and a safe unit label.
		expect(
			isValidEquivalentPreset({
				kind: "unit",
				id: "bags",
				icon: "",
				label: "Bags",
				perKwh: 0,
				unit: "bags",
			}),
		).toBe(false);
		expect(
			isValidEquivalentPreset({
				kind: "unit",
				id: "bags",
				icon: "",
				label: "Bags",
				perKwh: 10,
				unit: "",
			}),
		).toBe(false);
		expect(
			isValidEquivalentPreset({
				kind: "unit",
				id: "bags",
				icon: "",
				label: "Bags",
				perKwh: 10,
				unit: "a\u0007b",
			}),
		).toBe(false);
		// An unknown kind is neither power nor unit.
		expect(
			isValidEquivalentPreset({
				kind: "watts",
				id: "x",
				icon: "",
				label: "X",
				watts: 10,
			}),
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
