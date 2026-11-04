"""Counting-inference adapters.

The production adapter REUSES the already-deployed counting capability; it
performs no new model setup:

- Weights: the trained SAM3 checkpoint already exists in Modal storage on the
  read-only `sam3-checkpoint` Volume, mounted at `/checkpoints` by the
  existing GPU service, which loads `/checkpoints/sam3.pt` with
  `load_from_HF=False` (see SAM3/modal_counter.py, unmodified).
- Service: the deployed `epikd-sam3-counter` app, class `ObjectCounter`,
  authenticated method `count`, environment `main`. This adapter only submits
  work to it with `.spawn()` and retrieves results by retained call ID with
  `modal.FunctionCall.from_id`. It never redeploys, changes, or re-creates the
  GPU service, never uploads/downloads/duplicates/retrains weights, and never
  exposes weights or Modal credentials to the browser.
- Storage separation: phone photos and application results live on the
  dedicated capture Volume. Approved live calls ALSO write a second copy
  under legacy `sam3-outputs/counter-tests/`, requiring the archive opt-in.

With CAPTURE_MODAL_ENABLED unset the adapter fails explicitly instead of
returning a success-shaped stub.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Protocol

from .config import Settings


class AdapterNotConfigured(RuntimeError):
    """Raised when live inference is requested but no adapter is configured."""


class ArchiveOptInRequired(RuntimeError):
    """Fail-closed gate for the legacy counter archive.

    The existing ObjectCounter.count unconditionally stores input.png,
    annotated.png and result.json under sam3-outputs/counter-tests/. Reusing
    it therefore creates a second copy of every submitted image and result in
    addition to the dedicated capture volume. Live submission requires the
    documented production opt-in CAPTURE_ALLOW_LEGACY_COUNTER_ARCHIVE=1,
    acknowledging that archive; without it nothing is sent.
    """


@dataclass(frozen=True)
class CountResult:
    report: dict[str, Any]
    annotated_png: bytes


class CounterAdapter(Protocol):
    def spawn(self, image_bytes: bytes, prompt: str, threshold: float) -> str:
        """Submit one counting job; return the retained call ID."""
        ...

    def poll(self, call_id: str, timeout_seconds: float) -> CountResult | None:
        """Return the finished result, or None while the call is pending."""
        ...


class UnconfiguredAdapter:
    """Fails loudly. Never fabricates a result."""

    def __init__(self, settings: Settings) -> None:
        self._settings = settings

    def spawn(self, image_bytes: bytes, prompt: str, threshold: float) -> str:
        raise AdapterNotConfigured(
            "Live counting is not configured: set CAPTURE_MODAL_ENABLED=1 and provide Modal "
            "credentials in the deployment environment. No fake result is produced."
        )

    def poll(self, call_id: str, timeout_seconds: float) -> CountResult | None:
        raise AdapterNotConfigured(
            "Live counting is not configured: set CAPTURE_MODAL_ENABLED=1 and provide Modal "
            "credentials in the deployment environment. No fake result is produced."
        )


class ModalCounterAdapter:
    """Adapter over the EXISTING deployed ObjectCounter.count Modal method.

    Reuse contract: app `epikd-sam3-counter`, class `ObjectCounter`, method
    `count`, environment `main` (all configurable via CAPTURE_MODAL_*). The
    existing GPU service keeps its own read-only `sam3-checkpoint` mount and
    is neither redeployed nor modified here. No weights are moved, copied, or
    retrained; no checkpoint storage is duplicated.

    Known dual-copy behavior (not hidden): each call of the existing count
    method writes input.png, annotated.png and result.json under
    `sam3-outputs/counter-tests/`, so a second copy of the image and result
    exists besides the capture volume. Live submission therefore requires the
    explicit production opt-in CAPTURE_ALLOW_LEGACY_COUNTER_ARCHIVE=1; this
    adapter fails closed without it.
    """

    def __init__(self, settings: Settings) -> None:
        self._settings = settings

    def _require_archive_opt_in(self) -> None:
        if not self._settings.allow_legacy_counter_archive:
            raise ArchiveOptInRequired(
                "Live submission blocked: the deployed ObjectCounter.count archives "
                "input.png, annotated.png and result.json under sam3-outputs/counter-tests/ "
                "in addition to the capture volume. Set CAPTURE_ALLOW_LEGACY_COUNTER_ARCHIVE=1 "
                "in production after operator confirmation of access, retention and deletion "
                "rules for both stores. No submission was made."
            )

    def _counter(self):  # pragma: no cover - requires Modal credentials
        import modal

        counter = modal.Cls.from_name(
            self._settings.modal_app_name,
            self._settings.modal_counter_class,
            environment_name=self._settings.modal_env,
        )()
        return counter

    def spawn(self, image_bytes: bytes, prompt: str, threshold: float) -> str:  # pragma: no cover
        self._require_archive_opt_in()  # fail closed before any Modal contact
        call = self._counter().count.spawn(image_bytes, prompt, threshold)
        return call.object_id

    def poll(self, call_id: str, timeout_seconds: float) -> CountResult | None:  # pragma: no cover
        import modal

        call = modal.FunctionCall.from_id(call_id)
        try:
            result = call.get(timeout=timeout_seconds)
        except (TimeoutError, modal.exception.TimeoutError):
            # Modal's SDK timeout is not a subclass of the built-in
            # TimeoutError. Both mean the retained call is still pending.
            return None
        return CountResult(report=result["report"], annotated_png=result["annotated_png"])


def build_adapter(settings: Settings) -> CounterAdapter:
    if not settings.modal_enabled:
        return UnconfiguredAdapter(settings)
    return ModalCounterAdapter(settings)