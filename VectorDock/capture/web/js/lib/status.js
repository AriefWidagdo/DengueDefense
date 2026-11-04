/**
 * Status mapping for the capture upload lifecycle.
 *
 * The backend keeps three state groups separate (see PHONE_CAPTURE_SPEC.md
 * section 6): upload status (receiving/stored/failed), processing state
 * (queued/running/completed/failed) and review state (pending_review/
 * accepted/rejected). This module combines them into one honest UI state.
 * It never invents a success state: a failed count is never a zero catch,
 * and a completed job is not an accepted measurement.
 */

export const UI_STATE = {
  SAVING: "saving",
  SAVED_QUEUED: "saved-queued",
  PROCESSING: "processing",
  FAILED_UPLOAD: "failed-upload",
  FAILED_PROCESSING: "failed-processing",
  NEEDS_ATTENTION: "needs-attention",
  PENDING_REVIEW: "pending-review",
  ACCEPTED: "accepted",
  REJECTED: "rejected",
};

const LABELS = {
  [UI_STATE.SAVING]: "Saving photo…",
  [UI_STATE.SAVED_QUEUED]: "Saved — queued for counting",
  [UI_STATE.PROCESSING]: "Counting in progress",
  [UI_STATE.FAILED_UPLOAD]: "Upload failed",
  [UI_STATE.FAILED_PROCESSING]: "Counting failed",
  [UI_STATE.NEEDS_ATTENTION]: "Counting needs supervisor attention",
  [UI_STATE.PENDING_REVIEW]: "Pending human review",
  [UI_STATE.ACCEPTED]: "Accepted",
  [UI_STATE.REJECTED]: "Rejected",
};

const TONES = {
  [UI_STATE.SAVING]: "busy",
  [UI_STATE.SAVED_QUEUED]: "busy",
  [UI_STATE.PROCESSING]: "busy",
  [UI_STATE.FAILED_UPLOAD]: "error",
  [UI_STATE.FAILED_PROCESSING]: "error",
  [UI_STATE.NEEDS_ATTENTION]: "warn",
  [UI_STATE.PENDING_REVIEW]: "info",
  [UI_STATE.ACCEPTED]: "ok",
  [UI_STATE.REJECTED]: "warn",
};

/**
 * Combine one UploadOut payload into a single UI state.
 * Returns { state, label, tone, poll, detail }.
 */
export function deriveUploadState(upload) {
  if (!upload || typeof upload !== "object") {
    return { state: UI_STATE.FAILED_UPLOAD, label: LABELS[UI_STATE.FAILED_UPLOAD], tone: "error", poll: false, detail: "No upload record." };
  }
  if (upload.status === "receiving") {
    return { state: UI_STATE.SAVING, label: LABELS[UI_STATE.SAVING], tone: "busy", poll: true, detail: "The server has reserved this upload." };
  }
  if (upload.status === "failed") {
    return {
      state: UI_STATE.FAILED_UPLOAD,
      label: LABELS[UI_STATE.FAILED_UPLOAD],
      tone: "error",
      poll: false,
      detail: upload.failure_reason || "The server could not store this photo. Retry the upload or take it again.",
    };
  }
  const processing = upload.processing;
  if (!processing) {
    return { state: UI_STATE.SAVED_QUEUED, label: LABELS[UI_STATE.SAVED_QUEUED], tone: "busy", poll: true, detail: "The photo is stored. A counting job has not been reported yet." };
  }
  if (processing.needs_attention) {
    return { state: UI_STATE.NEEDS_ATTENTION, label: LABELS[UI_STATE.NEEDS_ATTENTION], tone: "warn", poll: false,
      detail: "Automatic dispatch stopped at its retry limit. The photo is saved. Ask a supervisor to inspect the job. If a new photo is required, use the explicit retake action. It records the request and does not restart this job or resume automatic retries." };
  }
  if (processing.state === "queued") {
    return { state: UI_STATE.SAVED_QUEUED, label: LABELS[UI_STATE.SAVED_QUEUED], tone: "busy", poll: true, detail: "Waiting for a counting worker." };
  }
  if (processing.state === "running") {
    return { state: UI_STATE.PROCESSING, label: LABELS[UI_STATE.PROCESSING], tone: "busy", poll: true, detail: "The counter is working on the photo. This can take a while." };
  }
  if (processing.state === "failed") {
    return {
      state: UI_STATE.FAILED_PROCESSING,
      label: LABELS[UI_STATE.FAILED_PROCESSING],
      tone: "error",
      poll: false,
      detail: processing.failure_reason || "Counting did not finish. This is not a zero result. Retry processing or request a retake.",
    };
  }
  // processing.state === "completed": a candidate exists, human review decides.
  const review = upload.review || {};
  if (review.state === "accepted") {
    return { state: UI_STATE.ACCEPTED, label: LABELS[UI_STATE.ACCEPTED], tone: "ok", poll: false, detail: "A reviewer accepted a measurement for this sample." };
  }
  if (review.state === "rejected") {
    return { state: UI_STATE.REJECTED, label: LABELS[UI_STATE.REJECTED], tone: "warn", poll: false, detail: "A reviewer rejected this sample. The rejection reason is recorded with the measurement." };
  }
  return { state: UI_STATE.PENDING_REVIEW, label: LABELS[UI_STATE.PENDING_REVIEW], tone: "info", poll: false, detail: "The candidate count needs a human reviewer." };
}

export function shouldPoll(uiState) {
  return Boolean(uiState && uiState.poll);
}

export function stateLabel(state) {
  return LABELS[state] || state;
}
