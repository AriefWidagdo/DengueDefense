"""Stage A2: ModalVolumeStorage commits through the exact mounted Volume handle.

SDK fakes/spies prove the same handle is committed without contacting Modal.
"""

from __future__ import annotations

import threading
from concurrent.futures import ThreadPoolExecutor

import pytest


from app.config import ConfigError
from app.storage import LocalDirectoryStorage, ModalVolumeStorage, build_storage


class FakeVolumeHandle:
    """Spy standing in for a hydrated modal.Volume; no Modal contact."""

    def __init__(self, name: str = "vectordock-capture") -> None:
        self.name = name
        self.commits = 0
        self.reloads = 0
        self.saved: list[str] = []

    def commit(self) -> None:
        self.commits += 1

    def reload(self) -> None:
        self.reloads += 1


def test_save_commits_the_exact_configured_handle(tmp_path):
    handle = FakeVolumeHandle("vectordock-capture")
    storage = ModalVolumeStorage(handle, str(tmp_path), expected_volume_name="vectordock-capture")
    storage.save("uploads/abc/original.jpg", b"data")
    assert handle.commits == 1
    assert handle.saved == []
    # The committed handle is the same object that was passed in (identity).
    assert storage.volume is handle
    assert storage.read("uploads/abc/original.jpg") == b"data"
    assert storage.exists("uploads/abc/original.jpg")
    assert handle.reloads == 3  # save, read and exists each refresh the mount


def test_mismatched_handle_name_fails_closed(tmp_path):
    handle = FakeVolumeHandle("some-other-volume")
    with pytest.raises(ConfigError) as error:
        ModalVolumeStorage(handle, str(tmp_path), expected_volume_name="vectordock-capture")
    assert "mismatch" in str(error.value)


def test_empty_runtime_name_requires_independently_matching_id(tmp_path):
    handle = FakeVolumeHandle("")
    handle.object_id = "vo-mounted"
    with pytest.raises(ConfigError, match="mismatch"):
        ModalVolumeStorage(handle, str(tmp_path), "vectordock-capture")
    with pytest.raises(ConfigError, match="mismatch"):
        ModalVolumeStorage(handle, str(tmp_path), "vectordock-capture", resolved_volume_id="vo-other")
    storage = ModalVolumeStorage(handle, str(tmp_path), "vectordock-capture", resolved_volume_id="vo-mounted")
    storage.save("test/file", b"ok")
    assert handle.commits == 1
    # A named mismatch cannot be overridden even by an equal ID.
    handle.name = "sam3-outputs"
    with pytest.raises(ConfigError, match="mismatch"):
        ModalVolumeStorage(handle, str(tmp_path), "vectordock-capture", resolved_volume_id="vo-mounted")


def test_handle_without_commit_fails_closed(tmp_path):
    class NoCommit:
        name = "vectordock-capture"

    with pytest.raises(ConfigError) as error:
        ModalVolumeStorage(NoCommit(), str(tmp_path), expected_volume_name="vectordock-capture")
    assert "commit" in str(error.value)


def test_handle_without_reload_fails_closed(tmp_path):
    class NoReload:
        name = "vectordock-capture"
        def commit(self): pass

    with pytest.raises(ConfigError, match="reload"):
        ModalVolumeStorage(NoReload(), str(tmp_path), expected_volume_name="vectordock-capture")


def test_separate_mounts_reload_files_committed_by_the_other_container(tmp_path):
    """A fake snapshots each mount until its explicit reload; no cloud calls."""
    shared = {}

    class SnapshotVolume(FakeVolumeHandle):
        def __init__(self, mount):
            super().__init__()
            self.mount = mount

        def commit(self):
            super().commit()
            for path in self.mount.rglob("*"):
                if path.is_file():
                    shared[path.relative_to(self.mount).as_posix()] = path.read_bytes()

        def reload(self):
            super().reload()
            for key, value in shared.items():
                path = self.mount / key
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(value)

    first_root, second_root = tmp_path / "api", tmp_path / "recovery"
    first_root.mkdir()
    second_root.mkdir()
    first_handle, second_handle = SnapshotVolume(first_root), SnapshotVolume(second_root)
    first = ModalVolumeStorage(first_handle, str(first_root), "vectordock-capture")
    second = ModalVolumeStorage(second_handle, str(second_root), "vectordock-capture")
    first.save("uploads/u/inference.png", b"normalized input")
    assert not (second_root / "uploads/u/inference.png").exists()  # stale mount
    assert second.exists("uploads/u/inference.png")
    assert second.read("uploads/u/inference.png") == b"normalized input"
    second.save("results/r/annotated.png", b"annotation")
    assert not (first_root / "results/r/annotated.png").exists()  # stale mount
    assert first.read("results/r/annotated.png") == b"annotation"
    assert first_handle.commits == second_handle.commits == 1


def test_mount_io_is_serialized_across_storage_instances(tmp_path):
    commit_started = threading.Event()
    release_commit = threading.Event()
    read_attempted = threading.Event()
    second_reloaded = threading.Event()

    class BlockingWriter(FakeVolumeHandle):
        def commit(self):
            commit_started.set()
            assert release_commit.wait(3), "test did not release commit"
            super().commit()

    class WatchingReader(FakeVolumeHandle):
        def reload(self):
            second_reloaded.set()
            super().reload()

    first = ModalVolumeStorage(BlockingWriter(), str(tmp_path), "vectordock-capture")
    second = ModalVolumeStorage(WatchingReader(), str(tmp_path), "vectordock-capture")
    def read():
        read_attempted.set()
        return second.exists("uploads/a.png")

    with ThreadPoolExecutor(max_workers=2) as pool:
        writing = pool.submit(first.save, "uploads/a.png", b"data")
        assert commit_started.wait(3)
        reading = pool.submit(read)
        assert read_attempted.wait(3)
        try:
            assert not second_reloaded.wait(0.2), "reload ran while another storage instance was committing"
        finally:
            release_commit.set()
        writing.result(timeout=3)
        assert reading.result(timeout=3)
        assert second_reloaded.is_set()


def test_reload_failure_never_returns_stale_data_or_saves(tmp_path):
    class FailingReload(FakeVolumeHandle):
        def reload(self):
            raise RuntimeError("test-only reload failure")

    (tmp_path / "stale.txt").write_bytes(b"stale")
    handle = FailingReload()
    storage = ModalVolumeStorage(handle, str(tmp_path), "vectordock-capture")
    for operation in (lambda: storage.exists("stale.txt"), lambda: storage.read("stale.txt"),
                      lambda: storage.save("new.txt", b"new")):
        with pytest.raises(RuntimeError, match="reload failure"):
            operation()
    assert not (tmp_path / "new.txt").exists()
    assert handle.commits == 0


def test_unmounted_root_fails_closed(tmp_path):
    handle = FakeVolumeHandle()
    with pytest.raises(ConfigError):
        ModalVolumeStorage(handle, str(tmp_path / "does-not-exist"))


def test_build_storage_never_constructs_a_volume_from_configuration_alone(tmp_path, monkeypatch):
    """Configuration alone cannot produce a Volume handle: fail closed."""
    monkeypatch.setenv("CAPTURE_ENV", "test")
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path / 's.sqlite3'}")
    monkeypatch.setenv("CAPTURE_STORAGE_BACKEND", "modal_volume")
    monkeypatch.setenv("CAPTURE_VOLUME_NAME", "vectordock-capture")
    monkeypatch.setenv("CAPTURE_VOLUME_MOUNT", str(tmp_path))
    from app.config import load_settings

    with pytest.raises(ConfigError) as error:
        build_storage(load_settings())
    assert "Volume handle" in str(error.value)


def test_production_storage_requires_the_mounted_handle(tmp_path, monkeypatch):
    from app.config import load_settings
    from app.main import _production_storage

    monkeypatch.setenv("CAPTURE_ENV", "test")
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path / 'p.sqlite3'}")
    monkeypatch.setenv("CAPTURE_VOLUME_NAME", "vectordock-capture")
    monkeypatch.setenv("CAPTURE_VOLUME_MOUNT", str(tmp_path))
    settings = load_settings()
    with pytest.raises(ConfigError):
        _production_storage(settings)  # no handle: fail closed
    handle = FakeVolumeHandle("vectordock-capture")
    storage = _production_storage(settings, volume=handle)
    assert storage.volume is handle


def test_local_storage_still_works_for_tests_and_development(tmp_path):
    storage = LocalDirectoryStorage(tmp_path / "s")
    storage.save("uploads/x/original.jpg", b"abc")
    assert storage.exists("uploads/x/original.jpg")


def test_checkpoint_volume_is_never_the_capture_target(tmp_path):
    handle = FakeVolumeHandle("sam3-checkpoint")
    with pytest.raises(ConfigError):
        ModalVolumeStorage(handle, str(tmp_path), expected_volume_name="vectordock-capture")