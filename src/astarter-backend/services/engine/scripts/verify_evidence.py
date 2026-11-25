"""Read-only verification for sealed local backtest evidence."""

from __future__ import annotations

import argparse
import json
import re
import sqlite3
import stat
import sys
import tempfile
from hashlib import sha256
from pathlib import Path

from stark_trading_os.audit.canonical_json import parse_json_object
from stark_trading_os.audit.replay import replay_digest_v1
from stark_trading_os.control.recovery import FinalizationRecovery
from stark_trading_os.control.registry import ControlStore, TerminalPublication

_ARTIFACT_PATHS = (
    "input-manifest.json",
    "events.ndjson",
    "reports/orders.json",
    "reports/fills.json",
    "reports/positions.json",
    "reports/account.json",
    "reports/metrics.json",
    "seal.json",
)
_RUN_ID = re.compile(r"bt_[0-9a-f]{32}")
_SHA256 = re.compile(r"[0-9a-f]{64}")


class EvidenceVerificationError(RuntimeError):
    """Evidence could not be proven from immutable artifacts and SQLite authority."""


class ReadOnlyStoreSnapshot:
    """Validated private database snapshot used without touching runtime state."""

    def __init__(
        self,
        *,
        store: ControlStore,
        directory: tempfile.TemporaryDirectory[str],
    ) -> None:
        self.store = store
        self._directory = directory

    def close(self) -> None:
        try:
            self.store.close()
        finally:
            self._directory.cleanup()


def _required_regular_file(path: Path, label: str) -> None:
    try:
        metadata = path.lstat()
    except FileNotFoundError as error:
        raise EvidenceVerificationError(f"{label} does not exist") from error
    if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISREG(metadata.st_mode):
        raise EvidenceVerificationError(f"{label} is not a regular file")


def open_read_only_store(runtime_root: Path) -> ReadOnlyStoreSnapshot:
    """Validate an existing v2 authority through an isolated private snapshot."""

    runtime = Path(runtime_root).resolve(strict=True)
    database = runtime / "control.sqlite"
    _required_regular_file(database, "control database")
    for suffix in ("-wal", "-shm"):
        if database.with_name(f"{database.name}{suffix}").exists():
            raise EvidenceVerificationError(
                "control database has active or uncheckpointed sidecars"
            )

    before = database.read_bytes()
    if any(database.with_name(f"{database.name}{suffix}").exists() for suffix in ("-wal", "-shm")):
        raise EvidenceVerificationError("control database changed while its snapshot was captured")
    after = database.read_bytes()
    if before != after:
        raise EvidenceVerificationError("control database changed while its snapshot was captured")

    directory = tempfile.TemporaryDirectory(prefix="stark-evidence-verifier-")
    snapshot_path = Path(directory.name) / "control.sqlite"
    connection: sqlite3.Connection | None = None
    try:
        snapshot_path.write_bytes(before)
        snapshot_path.chmod(0o600)
        connection = sqlite3.connect(
            snapshot_path,
            isolation_level=None,
            timeout=5.0,
        )
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        connection.execute("PRAGMA busy_timeout = 5000")
        connection.execute("PRAGMA journal_mode = WAL")
        connection.execute("PRAGMA synchronous = FULL")
        store = ControlStore(connection)
    except Exception as error:
        if connection is not None:
            connection.close()
        directory.cleanup()
        raise EvidenceVerificationError("control database schema is invalid") from error
    return ReadOnlyStoreSnapshot(store=store, directory=directory)


def _parse_events(payload: bytes) -> list[dict[str, object]]:
    lines = payload.splitlines()
    if not lines:
        raise EvidenceVerificationError("sealed events evidence is empty")
    try:
        return [parse_json_object(line) for line in lines]
    except ValueError as error:
        raise EvidenceVerificationError("sealed events evidence is invalid") from error


def _verify_with_store(
    *,
    runtime_root: Path,
    run_id: str,
    store: ControlStore,
) -> str:
    if type(run_id) is not str or not run_id:
        raise EvidenceVerificationError("run ID is invalid")
    publication = store.terminal_finalization(run_id=run_id)
    snapshot = store.run(run_id)
    if (
        type(publication) is not TerminalPublication
        or publication.state.value != "COMPLETED"
        or snapshot.state.value != "COMPLETED"
        or snapshot.evidence_status != "VERIFIED"
        or snapshot.input_manifest_hash is None
    ):
        raise EvidenceVerificationError("run is not a verified completed publication")
    recovery = FinalizationRecovery(store=store, runtime_root=runtime_root)
    payloads = recovery.read_artifacts(
        publication=publication,
        relative_paths=_ARTIFACT_PATHS,
    )
    if any(payload is None for payload in payloads):
        raise EvidenceVerificationError("sealed artifact inventory is incomplete")
    artifacts = {
        name: payload
        for name, payload in zip(_ARTIFACT_PATHS, payloads, strict=True)
        if payload is not None
    }
    manifest = artifacts["input-manifest.json"]
    if sha256(manifest).hexdigest() != snapshot.input_manifest_hash:
        raise EvidenceVerificationError("input manifest integrity verification failed")
    try:
        reports = {
            "orders": _parse_json_array(artifacts["reports/orders.json"]),
            "fills": _parse_json_array(artifacts["reports/fills.json"]),
            "positions": _parse_json_array(artifacts["reports/positions.json"]),
            "account": _parse_json_array(artifacts["reports/account.json"]),
            "metrics": parse_json_object(artifacts["reports/metrics.json"]),
        }
        return replay_digest_v1(
            {
                "input_manifest_hash": snapshot.input_manifest_hash,
                "events": _parse_events(artifacts["events.ndjson"]),
                "reports": reports,
            }
        )
    except (TypeError, ValueError) as error:
        raise EvidenceVerificationError("sealed replay integrity verification failed") from error


def _parse_json_array(payload: bytes) -> list[object]:
    import json

    value = json.loads(payload)
    if type(value) is not list:
        raise EvidenceVerificationError("sealed report is not an array")
    return value


def _require_existing_publish_lock(runtime_root: Path) -> None:
    lock = runtime_root / ".run-publish.lock"
    _required_regular_file(lock, "run publication lock")
    metadata = lock.stat()
    if stat.S_IMODE(metadata.st_mode) != 0o600 or metadata.st_size != 0:
        raise EvidenceVerificationError("run publication lock metadata is invalid")


def verify_run(runtime_root: Path, run_id: str) -> str:
    runtime = Path(runtime_root).resolve(strict=True)
    _require_existing_publish_lock(runtime)
    snapshot = open_read_only_store(runtime)
    try:
        return _verify_with_store(
            runtime_root=runtime,
            run_id=run_id,
            store=snapshot.store,
        )
    except EvidenceVerificationError:
        raise
    except Exception as error:
        raise EvidenceVerificationError("sealed evidence integrity verification failed") from error
    finally:
        snapshot.close()


def _verify_two_identical_inputs_with_store(
    *,
    runtime_root: Path,
    run_ids: tuple[str, str],
    store: ControlStore,
) -> tuple[str, str, str]:
    first_id, second_id = run_ids
    if first_id == second_id:
        raise EvidenceVerificationError("two distinct run IDs are required")
    first = store.run(first_id)
    second = store.run(second_id)
    if (
        first.input_manifest_hash is None
        or second.input_manifest_hash is None
        or first.input_manifest_hash != second.input_manifest_hash
    ):
        raise EvidenceVerificationError("verified runs do not share an input manifest")
    first_digest = _verify_with_store(
        runtime_root=runtime_root,
        run_id=first_id,
        store=store,
    )
    second_digest = _verify_with_store(
        runtime_root=runtime_root,
        run_id=second_id,
        store=store,
    )
    if first_digest != second_digest:
        raise EvidenceVerificationError("replay digest comparison failed")
    return first_id, second_id, first_digest


def verify_exact_two_identical_inputs(
    runtime_root: Path,
    run_ids: tuple[str, str],
) -> tuple[str, str, str]:
    """Verify one explicitly selected deterministic browser-run pair."""

    runtime = Path(runtime_root).resolve(strict=True)
    _require_existing_publish_lock(runtime)
    snapshot = open_read_only_store(runtime)
    try:
        return _verify_two_identical_inputs_with_store(
            runtime_root=runtime,
            run_ids=run_ids,
            store=snapshot.store,
        )
    except EvidenceVerificationError:
        raise
    except Exception as error:
        raise EvidenceVerificationError("sealed evidence integrity verification failed") from error
    finally:
        snapshot.close()


def verify_latest_two_identical_inputs(runtime_root: Path) -> tuple[str, str, str]:
    runtime = Path(runtime_root).resolve(strict=True)
    _require_existing_publish_lock(runtime)
    snapshot = open_read_only_store(runtime)
    store = snapshot.store
    try:
        rows = store._connection.execute(  # noqa: SLF001 - local read-only verifier authority
            """
            SELECT run_id, input_manifest_hash
            FROM runs
            WHERE state = 'COMPLETED'
              AND evidence_status = 'VERIFIED'
              AND input_manifest_hash IS NOT NULL
            ORDER BY completed_at_ns DESC, created_at_ns DESC, run_id DESC
            LIMIT 2
            """
        ).fetchall()
        if len(rows) != 2:
            raise EvidenceVerificationError("two verified completed runs are required")
        first_id, first_hash = str(rows[0][0]), str(rows[0][1])
        second_id, second_hash = str(rows[1][0]), str(rows[1][1])
        if first_hash != second_hash:
            raise EvidenceVerificationError(
                "latest two verified completed runs do not share an input manifest"
            )
        return _verify_two_identical_inputs_with_store(
            runtime_root=runtime,
            run_ids=(first_id, second_id),
            store=store,
        )
    except EvidenceVerificationError:
        raise
    except Exception as error:
        raise EvidenceVerificationError("sealed evidence integrity verification failed") from error
    finally:
        snapshot.close()


def _browser_acceptance_run_ids(path: Path) -> tuple[str, str]:
    _required_regular_file(path, "browser acceptance run manifest")

    def reject_duplicate_keys(pairs: list[tuple[str, object]]) -> dict[str, object]:
        value: dict[str, object] = {}
        for key, item in pairs:
            if key in value:
                raise ValueError("duplicate browser acceptance manifest key")
            value[key] = item
        return value

    try:
        value = json.loads(path.read_bytes(), object_pairs_hook=reject_duplicate_keys)
    except (OSError, TypeError, ValueError) as error:
        raise EvidenceVerificationError(
            "browser acceptance run manifest is invalid"
        ) from error
    if type(value) is not dict:
        raise EvidenceVerificationError("browser acceptance run manifest is invalid")
    run_ids = value.get("run_ids")
    screenshots = value.get("screenshots")
    if (
        set(value) != {"input_manifest_hash", "run_ids", "schema", "screenshots"}
        or value.get("schema") != "BrowserAcceptanceRuns.v1"
        or type(value.get("input_manifest_hash")) is not str
        or _SHA256.fullmatch(value["input_manifest_hash"]) is None
        or type(run_ids) is not list
        or len(run_ids) != 2
        or any(
            type(run_id) is not str or _RUN_ID.fullmatch(run_id) is None
            for run_id in run_ids
        )
        or run_ids[0] == run_ids[1]
        or type(screenshots) is not list
        or len(screenshots) < 2
        or any(type(screenshot) is not str for screenshot in screenshots)
    ):
        raise EvidenceVerificationError("browser acceptance run manifest is invalid")
    return run_ids[0], run_ids[1]


def _arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--run",
        choices=(
            "browser-acceptance",
            "exact-two-identical-inputs",
            "latest-two-identical-inputs",
        ),
        required=True,
    )
    parser.add_argument("--browser-run-manifest", type=Path)
    parser.add_argument("--run-id", action="append", default=[])
    parser.add_argument(
        "--runtime-root",
        type=Path,
        default=Path(__file__).resolve().parents[3] / "var" / "trading",
    )
    return parser.parse_args()


def main() -> int:
    arguments = _arguments()
    try:
        if arguments.run == "browser-acceptance":
            if arguments.browser_run_manifest is None or arguments.run_id:
                raise EvidenceVerificationError(
                    "browser-acceptance requires only --browser-run-manifest"
                )
            first, second, digest = verify_exact_two_identical_inputs(
                arguments.runtime_root,
                _browser_acceptance_run_ids(arguments.browser_run_manifest),
            )
        elif arguments.run == "exact-two-identical-inputs":
            if arguments.browser_run_manifest is not None:
                raise EvidenceVerificationError(
                    "--browser-run-manifest is only valid with browser-acceptance"
                )
            if len(arguments.run_id) != 2:
                raise EvidenceVerificationError(
                    "exact-two-identical-inputs requires exactly two --run-id values"
                )
            first, second, digest = verify_exact_two_identical_inputs(
                arguments.runtime_root,
                (arguments.run_id[0], arguments.run_id[1]),
            )
        else:
            if arguments.run_id or arguments.browser_run_manifest is not None:
                raise EvidenceVerificationError(
                    "run selectors are not valid with latest-two-identical-inputs"
                )
            first, second, digest = verify_latest_two_identical_inputs(
                arguments.runtime_root
            )
    except (OSError, EvidenceVerificationError) as error:
        print(str(error), file=sys.stderr)
        return 1
    print(f"evidence verified: {first} {second} replay_digest_v1={digest}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
