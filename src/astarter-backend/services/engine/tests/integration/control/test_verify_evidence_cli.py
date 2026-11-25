from __future__ import annotations

import importlib.util
import json
import sqlite3
import sys
from hashlib import sha256
from pathlib import Path
from types import ModuleType

import pytest
from test_tamper_detection import _publish_five_report_root

REPOSITORY_ROOT = Path(__file__).resolve().parents[5]


def _load_verifier() -> ModuleType:
    path = REPOSITORY_ROOT / "services" / "engine" / "scripts" / "verify_evidence.py"
    spec = importlib.util.spec_from_file_location("verify_evidence_cli", path)
    if spec is None or spec.loader is None:
        raise RuntimeError("verify_evidence module is unavailable")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _content_snapshot(root: Path) -> dict[str, str]:
    return {
        str(path.relative_to(root)): sha256(path.read_bytes()).hexdigest()
        for path in sorted(root.rglob("*"))
        if path.is_file()
    }


def test_read_only_verifier_rejects_missing_database_without_creating_it(
    tmp_path: Path,
) -> None:
    verifier = _load_verifier()
    runtime = tmp_path / "runtime"
    runtime.mkdir(mode=0o700)

    with pytest.raises(verifier.EvidenceVerificationError, match="does not exist"):
        verifier.open_read_only_store(runtime)

    assert not (runtime / "control.sqlite").exists()


def test_read_only_verifier_rejects_legacy_schema_without_migrating_it(
    tmp_path: Path,
) -> None:
    verifier = _load_verifier()
    runtime = tmp_path / "runtime"
    runtime.mkdir(mode=0o700)
    database = runtime / "control.sqlite"
    connection = sqlite3.connect(database)
    connection.executescript(
        "PRAGMA journal_mode = WAL; CREATE TABLE legacy (value TEXT); PRAGMA user_version = 1;"
    )
    connection.close()
    before = database.read_bytes()

    with pytest.raises(verifier.EvidenceVerificationError, match="schema"):
        verifier.open_read_only_store(runtime)

    assert database.read_bytes() == before
    assert sqlite3.connect(database).execute("PRAGMA user_version").fetchone()[0] == 1


def test_read_only_verifier_rejects_active_wal_without_touching_runtime(
    tmp_path: Path,
) -> None:
    verifier = _load_verifier()
    runtime = tmp_path / "runtime"
    runtime.mkdir(mode=0o700)
    database = runtime / "control.sqlite"
    connection = sqlite3.connect(database)
    connection.execute("PRAGMA journal_mode = WAL")
    connection.execute("CREATE TABLE active (value TEXT)")
    connection.execute("INSERT INTO active VALUES ('pending')")
    before = _content_snapshot(runtime)

    try:
        with pytest.raises(verifier.EvidenceVerificationError, match="sidecars"):
            verifier.open_read_only_store(runtime)

        assert _content_snapshot(runtime) == before
    finally:
        connection.close()


def test_read_only_verifier_rejects_a_database_that_changes_during_capture(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    verifier = _load_verifier()
    runtime = tmp_path / "runtime"
    runtime.mkdir(mode=0o700)
    database = runtime / "control.sqlite"
    connection = sqlite3.connect(database)
    connection.execute("CREATE TABLE stable (value TEXT)")
    connection.close()
    original = database.read_bytes()
    real_read_bytes = Path.read_bytes
    reads = 0

    def changing_read(path: Path) -> bytes:
        nonlocal reads
        payload = real_read_bytes(path)
        if path == database:
            reads += 1
            if reads == 2:
                return payload + b"changed"
        return payload

    monkeypatch.setattr(Path, "read_bytes", changing_read)

    with pytest.raises(verifier.EvidenceVerificationError, match="changed"):
        verifier.open_read_only_store(runtime)

    assert real_read_bytes(database) == original


def test_read_only_verifier_recomputes_one_sealed_run_without_changing_state(
    tmp_path: Path,
) -> None:
    verifier = _load_verifier()
    store, runtime, run_id = _publish_five_report_root(tmp_path)
    store.close()
    before = _content_snapshot(runtime)

    digest = verifier.verify_run(runtime, run_id)

    assert len(digest) == 64
    assert _content_snapshot(runtime) == before


def test_read_only_verifier_rejects_corrupted_sealed_evidence_without_repair(
    tmp_path: Path,
) -> None:
    verifier = _load_verifier()
    store, runtime, run_id = _publish_five_report_root(tmp_path)
    store.close()
    run_root = runtime / "runs" / run_id
    metrics = run_root / "reports" / "metrics.json"
    metrics.chmod(0o600)
    metrics.write_bytes(metrics.read_bytes() + b"\n")
    metrics.chmod(0o400)
    corrupted = _content_snapshot(runtime)

    with pytest.raises(verifier.EvidenceVerificationError, match="integrity"):
        verifier.verify_run(runtime, run_id)

    assert _content_snapshot(runtime) == corrupted


def test_cli_verifies_the_two_explicit_browser_run_ids(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    verifier = _load_verifier()
    observed: list[tuple[Path, tuple[str, str]]] = []

    def verify_exact(runtime_root: Path, run_ids: tuple[str, str]) -> tuple[str, str, str]:
        observed.append((runtime_root, run_ids))
        return run_ids[0], run_ids[1], "a" * 64

    monkeypatch.setattr(verifier, "verify_exact_two_identical_inputs", verify_exact)
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "verify_evidence.py",
            "--run",
            "exact-two-identical-inputs",
            "--run-id",
            "bt_browser_first",
            "--run-id",
            "bt_browser_second",
            "--runtime-root",
            "/private/runtime",
        ],
    )

    assert verifier.main() == 0
    assert observed == [
        (Path("/private/runtime"), ("bt_browser_first", "bt_browser_second"))
    ]
    assert "bt_browser_first bt_browser_second" in capsys.readouterr().out


def test_cli_selects_exact_ids_from_the_browser_acceptance_manifest(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    verifier = _load_verifier()
    manifest = tmp_path / "happy-path-runs.json"
    manifest.write_text(
        json.dumps(
            {
                "input_manifest_hash": "b" * 64,
                "run_ids": [
                    "bt_11111111111111111111111111111111",
                    "bt_22222222222222222222222222222222",
                ],
                "schema": "BrowserAcceptanceRuns.v1",
                    "screenshots": ["desktop.png", "mobile.png"],
            }
        ),
        encoding="utf-8",
    )
    observed: list[tuple[str, str]] = []

    def verify_exact(
        runtime_root: Path,
        run_ids: tuple[str, str],
    ) -> tuple[str, str, str]:
        del runtime_root
        observed.append(run_ids)
        return run_ids[0], run_ids[1], "c" * 64

    monkeypatch.setattr(verifier, "verify_exact_two_identical_inputs", verify_exact)
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "verify_evidence.py",
            "--run",
            "browser-acceptance",
            "--browser-run-manifest",
            str(manifest),
        ],
    )

    assert verifier.main() == 0
    assert observed == [
        (
            "bt_11111111111111111111111111111111",
            "bt_22222222222222222222222222222222",
        )
    ]


@pytest.mark.parametrize(
    "payload",
    [
        b'{"schema":"BrowserAcceptanceRuns.v1","schema":"BrowserAcceptanceRuns.v1"}',
        json.dumps(
            {
                "input_manifest_hash": "b" * 64,
                "run_ids": [
                    "bt_11111111111111111111111111111111",
                    "bt_11111111111111111111111111111111",
                ],
                "schema": "BrowserAcceptanceRuns.v1",
                "screenshots": ["desktop.png", "mobile.png"],
            }
        ).encode(),
    ],
)
def test_browser_acceptance_manifest_rejects_ambiguous_run_selection(
    tmp_path: Path,
    payload: bytes,
) -> None:
    verifier = _load_verifier()
    manifest = tmp_path / "happy-path-runs.json"
    manifest.write_bytes(payload)

    with pytest.raises(verifier.EvidenceVerificationError, match="manifest is invalid"):
        verifier._browser_acceptance_run_ids(manifest)
