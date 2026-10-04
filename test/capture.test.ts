import { describe, expect, it } from "vitest";
import {
	MAX_PENDING_RECORDS,
	type CapturedRecord,
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
 * The message_end integration path (matching, once-only consumption, telemetry
 * persistence, and cross-provider isolation) is covered end-to-end against the
 * real extension in test/lifecycle-integration.test.ts.
 */
