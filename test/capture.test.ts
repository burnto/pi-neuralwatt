import { describe, expect, it } from "vitest";
import {
	MAX_PENDING_RECORDS,
	type CapturedRecord,
	addTelemetryToTotals,
	buildTelemetry,
	emptyTotals,
	pruneCaptures,
	takeCaptureIndex,
} from "../lib.ts";

const capture = (
	responseId: string | undefined,
	energyKwh?: number,
	at = 1000,
): CapturedRecord => ({
	record: energyKwh === undefined ? {} : { energy: { energy_kwh: energyKwh } },
	responseId,
	capturedAt: at,
});

describe("takeCaptureIndex", () => {
	it("matches by response id only", () => {
		const captures = [
			capture("warm-a", 0.1),
			capture("real-b", 0.2),
			capture("warm-c", 0.3),
		];
		// A cache-warmer capture must not be consumed by an unrelated response.
		expect(takeCaptureIndex(captures, "real-b", 1000)).toBe(1);
		expect(takeCaptureIndex(captures, "missing", 1000)).toBe(-1);
	});

	it("never pairs an unnamed capture with an unnamed message", () => {
		const captures = [capture(undefined, 0.1), capture(undefined, 0.2)];
		expect(takeCaptureIndex(captures, undefined, 1000)).toBe(-1);
	});

	it("ignores expired captures", () => {
		const captures = [capture("old", 0.1, 1_000)];
		expect(takeCaptureIndex(captures, "old", 120_000, 60_000)).toBe(-1);
		expect(takeCaptureIndex(captures, "old", 30_000, 60_000)).toBe(0);
	});
});

describe("pruneCaptures", () => {
	it("drops expired captures in place", () => {
		const captures = [capture("expired", 0.1, 1_000), capture("fresh", 0.2, 100_000)];
		pruneCaptures(captures, 120_000);
		expect(captures.map((item) => item.responseId)).toEqual(["fresh"]);
	});

	it("bounds the number of pending captures", () => {
		const captures: CapturedRecord[] = [];
		for (let i = 0; i < MAX_PENDING_RECORDS + 5; i++) {
			captures.push(capture(`r-${i}`, 0.1, 1000 + i));
		}
		pruneCaptures(captures, 2000);
		expect(captures).toHaveLength(MAX_PENDING_RECORDS);
		// The oldest records are discarded first.
		expect(captures[0].responseId).toBe("r-5");
	});
});

/*
 * Boundary-level simulation of the message_end path: interleaved captures are
 * matched by response id, consumed exactly once, and turned into telemetry.
 * This catches cross-assignment and double-recording without a live Pi.
 */
describe("message_end matching (simulated)", () => {
	it("attributes each response to its own capture and records once", () => {
		const captures = [
			capture("warm-1", 9),
			capture("resp-1", 0.1, 1000),
			capture("warm-2", 9, 1001),
			capture("resp-2", 0.2, 1002),
		];
		let totals = emptyTotals();
		const recorded: string[] = [];

		for (const responseId of ["resp-1", "resp-2"]) {
			const index = takeCaptureIndex(captures, responseId, 2000);
			const matched = index >= 0 ? captures.splice(index, 1)[0] : undefined;
			const telemetry = buildTelemetry(matched?.record ?? {}, {
				modelId: "m",
				responseId,
				accountingMethod: "energy",
				rateUsdPerKwh: 10,
				recordedAt: "2026-01-01T00:00:00.000Z",
			});
			totals = addTelemetryToTotals(totals, telemetry);
			recorded.push(responseId);
		}

		expect(recorded).toEqual(["resp-1", "resp-2"]);
		expect(totals.responses).toBe(2);
		expect(totals.energyKwh).toBeCloseTo(0.3, 10);
		// The two warm captures were never consumed.
		expect(captures.map((item) => item.responseId)).toEqual(["warm-1", "warm-2"]);
	});

	it("records missing telemetry when no capture exists", () => {
		const captures: CapturedRecord[] = [];
		const index = takeCaptureIndex(captures, "no-capture", 2000);
		expect(index).toBe(-1);
		const telemetry = buildTelemetry({}, {
			modelId: "m",
			responseId: "no-capture",
			rateUsdPerKwh: 10,
			recordedAt: "2026-01-01T00:00:00.000Z",
		});
		expect(telemetry.energy.status).toBe("missing");
		expect(telemetry.cost.status).toBe("missing");
	});

	it("does not re-record a capture that was already consumed", () => {
		const captures = [capture("resp-x", 0.1)];
		expect(takeCaptureIndex(captures, "resp-x", 2000)).toBe(0);
		captures.splice(0, 1);
		expect(takeCaptureIndex(captures, "resp-x", 2000)).toBe(-1);
	});
});
