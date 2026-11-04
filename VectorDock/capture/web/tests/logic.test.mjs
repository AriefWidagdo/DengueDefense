/**
 * Unit checks for the capture page's pure logic: upload state mapping,
 * idempotency key handling and capture-time formatting.
 * Run with: node tests/logic.test.mjs
 */

import assert from "node:assert/strict";
import { deriveUploadState, shouldPoll, UI_STATE } from "../js/lib/status.js";
import { newClientKey, isValidClientKey, captureTimeParts, datetimeLocalParts } from "../js/lib/idempotency.js";

let passed = 0;
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed += 1;
      console.log(`ok - ${name}`);
    })
    .catch((error) => {
      console.error(`FAIL - ${name}`);
      throw error;
    });
}

const upload = (overrides = {}) => ({
  upload_id: "u1",
  sample_id: 1,
  image_id: "img1",
  status: "stored",
  failure_reason: null,
  processing: { state: "queued", failure_reason: null, modal_call_id: null },
  review: { state: "pending_review", measurement_id: null, measurement_revision: null },
  result: null,
  ...overrides,
});

await test("receiving upload maps to saving and keeps polling", () => {
  const derived = deriveUploadState(upload({ status: "receiving" }));
  assert.equal(derived.state, UI_STATE.SAVING);
  assert.equal(shouldPoll(derived), true);
});

await test("stored with queued job maps to saved/queued", () => {
  const derived = deriveUploadState(upload());
  assert.equal(derived.state, UI_STATE.SAVED_QUEUED);
  assert.equal(shouldPoll(derived), true);
});

await test("stored with running job maps to processing", () => {
  const derived = deriveUploadState(upload({ processing: { state: "running", failure_reason: null, modal_call_id: "c1" } }));
  assert.equal(derived.state, UI_STATE.PROCESSING);
  assert.equal(shouldPoll(derived), true);
});

await test("completed job with no measurement is pending human review, never accepted", () => {
  const derived = deriveUploadState(upload({
    processing: { state: "completed", failure_reason: null, modal_call_id: "c1" },
    result: { result_id: "r1", candidate_count: 3, annotation_url: "/api/results/r1/annotation" },
  }));
  assert.equal(derived.state, UI_STATE.PENDING_REVIEW);
  assert.equal(shouldPoll(derived), false);
});

await test("failed upload maps to failed and never to a zero catch", () => {
  const withReason = deriveUploadState(upload({ status: "failed", failure_reason: "image exceeds the 12 MiB upload limit" }));
  assert.equal(withReason.state, UI_STATE.FAILED_UPLOAD);
  assert.equal(withReason.detail, "image exceeds the 12 MiB upload limit");
  const withoutReason = deriveUploadState(upload({ status: "failed", failure_reason: null }));
  assert.equal(withoutReason.state, UI_STATE.FAILED_UPLOAD);
  assert.match(withoutReason.detail, /could not store this photo/);
  assert.equal(shouldPoll(withoutReason), false);
});

await test("failed processing stays distinct from a valid zero", () => {
  const withReason = deriveUploadState(upload({
    processing: { state: "failed", failure_reason: "counter unavailable", modal_call_id: null },
  }));
  assert.equal(withReason.state, UI_STATE.FAILED_PROCESSING);
  assert.equal(withReason.detail, "counter unavailable");
  const withoutReason = deriveUploadState(upload({
    processing: { state: "failed", failure_reason: null, modal_call_id: null },
  }));
  assert.equal(withoutReason.state, UI_STATE.FAILED_PROCESSING);
  assert.match(withoutReason.detail, /not a zero result/);
});

await test("accepted and rejected review states are distinct", () => {
  const accepted = deriveUploadState(upload({
    processing: { state: "completed", failure_reason: null, modal_call_id: "c1" },
    review: { state: "accepted", measurement_id: "m1", measurement_revision: 1 },
  }));
  assert.equal(accepted.state, UI_STATE.ACCEPTED);
  const rejected = deriveUploadState(upload({
    processing: { state: "completed", failure_reason: null, modal_call_id: "c1" },
    review: { state: "rejected", measurement_id: "m1", measurement_revision: 1 },
  }));
  assert.equal(rejected.state, UI_STATE.REJECTED);
});

await test("missing upload record maps to a failure, not a success", () => {
  const derived = deriveUploadState(null);
  assert.equal(derived.state, UI_STATE.FAILED_UPLOAD);
});

await test("client keys are random, prefixed and stable per generated value", () => {
  const key = newClientKey();
  assert.equal(isValidClientKey(key), true);
  assert.equal(isValidClientKey(newClientKey()), true);
  assert.notEqual(key, newClientKey());
  assert.match(key, /^vd1-[A-Za-z0-9_-]{20,24}$/);
});

await test("invalid client keys are refused", () => {
  assert.equal(isValidClientKey(""), false);
  assert.equal(isValidClientKey("tooshort"), false);
  assert.equal(isValidClientKey(null), false);
  assert.equal(isValidClientKey("vd1-"), false);
});

await test("capture time keeps the local wall clock and its explicit offset", () => {
  // UTC+05:30 fixed-offset date via a fake Date-like object
  const fake = {
    getFullYear: () => 2026,
    getMonth: () => 0,
    getDate: () => 7,
    getHours: () => 14,
    getMinutes: () => 5,
    getSeconds: () => 9,
    getTimezoneOffset: () => -330,
  };
  const parts = captureTimeParts(fake);
  assert.equal(parts.capturedAt, "2026-01-07T14:05:09");
  assert.equal(parts.capturedAtOffset, "+05:30");
});

await test("UTC maps to +00:00", () => {
  const fake = {
    getFullYear: () => 2026,
    getMonth: () => 5,
    getDate: () => 1,
    getHours: () => 0,
    getMinutes: () => 0,
    getSeconds: () => 0,
    getTimezoneOffset: () => 0,
  };
  const parts = captureTimeParts(fake);
  assert.equal(parts.capturedAt, "2026-06-01T00:00:00");
  assert.equal(parts.capturedAtOffset, "+00:00");
});

await test("datetime-local values gain seconds and the local offset", () => {
  const parts = datetimeLocalParts("2026-03-04T09:30");
  assert.equal(parts.capturedAt, "2026-03-04T09:30:00");
  assert.match(parts.capturedAtOffset, /^[+-]\d{2}:\d{2}$/);
  assert.equal(datetimeLocalParts("nonsense"), null);
  assert.equal(datetimeLocalParts(""), null);
});

console.log(`\nlogic.test: ${passed} checks passed`);
