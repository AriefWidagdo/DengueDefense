"""Storage interface for capture images and result files.

- LocalDirectoryStorage: local-directory implementation for tests and
  development. Local disk only.
- ModalVolumeStorage: production implementation backed by the dedicated
  capture Modal Volume mounted inside the worker/container.

The existing `sam3-checkpoint` volume stays read-only and this code refuses to
write under the legacy `counter-tests/` prefix (see config.volume_key_guard).
"""

from __future__ import annotations

import os
import threading
from pathlib import Path
from typing import Protocol

from .config import ConfigError, Settings, volume_key_guard


# A Modal container can hold more than one storage instance for the same
# mounted volume. Serialize reload, file access and commit within the process:
# Modal cannot reload a volume while it has open files.
_VOLUME_IO_LOCK = threading.RLock()


class FileStorage(Protocol):
    def save(self, key: str, data: bytes) -> None: ...
    def read(self, key: str) -> bytes: ...
    def exists(self, key: str) -> bool: ...


class LocalDirectoryStorage:
    """Local-disk storage for tests and development only."""

    def __init__(self, root: str | os.PathLike[str]) -> None:
        self.root = Path(root).resolve()
        self.root.mkdir(parents=True, exist_ok=True)

    def _resolve(self, key: str) -> Path:
        normalized = volume_key_guard(key)
        path = (self.root / normalized).resolve()
        if self.root != path and self.root not in path.parents:
            raise ValueError(f"Storage key escapes the storage root: {key}")
        path.parent.mkdir(parents=True, exist_ok=True)
        return path

    def save(self, key: str, data: bytes) -> None:
        self._resolve(key).write_bytes(data)

    def read(self, key: str) -> bytes:
        return self._resolve(key).read_bytes()

    def exists(self, key: str) -> bool:
        return self._resolve(key).is_file()


class ModalVolumeStorage:
    """Storage on the dedicated capture Modal Volume (production).

    Commits go through the EXACT hydrated Volume handle that the Modal entry
    point mounts; no name is looked up here, so the committed volume and the
    mounted volume cannot diverge. Reload that handle before each access to
    see files committed by other containers, and commit after each write.
    The process-wide lock keeps reloads from racing open storage files in this
    container. It never opens the legacy SAM3 output tree; approved
    live counting jobs (the existing counter service) separately archive a
    second copy under counter-tests/, gated by the documented opt-in.
    """

    def __init__(self, volume, mount_root: str, expected_volume_name: str | None = None,
                 *, resolved_volume_id: str | None = None) -> None:
        self.root = Path(mount_root)
        if not self.root.is_dir():
            raise ConfigError(f"Capture volume is not mounted at {mount_root}")
        commit = getattr(volume, "commit", None)
        if not callable(commit):
            raise ConfigError("The provided capture Volume handle has no commit() method")
        if not callable(getattr(volume, "reload", None)):
            raise ConfigError("The provided capture Volume handle has no reload() method")
        name = getattr(volume, "name", None)
        if expected_volume_name and name != expected_volume_name:
            # The Modal runtime can hydrate the mounted handle with an empty
            # name even though it retains its object ID. Accept that case only
            # after the entry point independently resolves the configured name
            # and verifies that it has the SAME object ID as this mount.
            actual_id = getattr(volume, "object_id", None)
            if name or not resolved_volume_id or not actual_id or actual_id != resolved_volume_id:
                raise ConfigError(
                    f"Capture Volume handle mismatch: mounted handle is {name!r}, "
                    f"configuration expects {expected_volume_name!r}; refusing to run"
                )
        self.volume = volume

    def _resolve(self, key: str) -> Path:
        normalized = volume_key_guard(key)
        path = (self.root / normalized).resolve()
        if self.root.resolve() not in path.parents and path != self.root.resolve():
            raise ValueError(f"Storage key escapes the volume mount: {key}")
        return path

    def save(self, key: str, data: bytes) -> None:
        with _VOLUME_IO_LOCK:
            self.volume.reload()
            path = self._resolve(key)
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
            # Commit the SAME handle that was mounted in the entry point.
            self.volume.commit()

    def read(self, key: str) -> bytes:
        with _VOLUME_IO_LOCK:
            self.volume.reload()
            return self._resolve(key).read_bytes()

    def exists(self, key: str) -> bool:
        with _VOLUME_IO_LOCK:
            self.volume.reload()
            return self._resolve(key).is_file()


def build_storage(settings: Settings) -> FileStorage:
    if settings.storage_backend == "local":
        if settings.is_production:
            raise ConfigError("Local storage is not allowed in production")
        return LocalDirectoryStorage(settings.storage_dir)
    # Fail closed: a hydrated Volume handle exists only inside the Modal
    # runtime. Entry points must construct ModalVolumeStorage(volume,
    # settings.volume_mount, settings.volume_name) themselves; building one
    # from configuration alone would risk committing a mismatched volume.
    raise ConfigError(
        "The modal_volume backend requires the mounted capture Volume handle: "
        "construct ModalVolumeStorage(volume, settings.volume_mount, settings.volume_name) "
        "inside the Modal entry point; never from configuration alone"
    )