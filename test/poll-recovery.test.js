import test from "node:test";
import assert from "node:assert/strict";
import { formatError, PollFailureTracker } from "../src/poll-recovery.js";

test("PollFailureTracker restarts after failures accumulate within the window", () => {
  let now = 0;
  const tracker = new PollFailureTracker({ threshold: 3, windowMs: 1000, now: () => now });

  assert.equal(tracker.recordFailure().shouldRestart, false);
  now = 400;
  assert.equal(tracker.recordFailure().shouldRestart, false);
  now = 800;
  assert.deepEqual(tracker.recordFailure(), { count: 3, shouldRestart: true });
});

test("PollFailureTracker discards failures outside the recovery window", () => {
  let now = 0;
  const tracker = new PollFailureTracker({ threshold: 2, windowMs: 1000, now: () => now });

  tracker.recordFailure();
  now = 1001;
  assert.deepEqual(tracker.recordFailure(), { count: 1, shouldRestart: false });
});

test("formatError includes nested transport error details", () => {
  const error = new TypeError("fetch failed", {
    cause: Object.assign(new Error("socket disconnected"), { code: "UND_ERR_SOCKET" }),
  });

  assert.equal(formatError(error), "fetch failed; cause: socket disconnected [UND_ERR_SOCKET]");
});
