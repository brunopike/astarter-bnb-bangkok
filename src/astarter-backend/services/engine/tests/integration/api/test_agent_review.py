from __future__ import annotations

import sqlite3
import stat
from collections.abc import Callable
from dataclasses import dataclass, replace
from hashlib import sha256
from pathlib import Path
from typing import Literal, Never

import pytest
from conftest import (
    ORIGIN,
    ApiHarness,
    RecordingCancellation,
    RecordingScheduler,
    _dependencies,
    seed_cancelled_runs,
    seed_hidden_cancelled_run,
    seed_verified_cancelled_run,
    seed_verified_terminal_run,
)
from fastapi.testclient import TestClient
from httpx2 import Response

from stark_trading_os.agent.evidence_scope import IndependentEvidenceScopeBuilder
from stark_trading_os.agent.models import RunReviewRequest, RunReviewResponse
from stark_trading_os.agent.openai_review import SensitiveQuestionRejected
from stark_trading_os.agent.service import (
    RunReviewBusy,
    RunReviewDeadlineExceeded,
    RunReviewService,
)
from stark_trading_os.control import dependencies as dependencies_module
from stark_trading_os.control.app import create_app
from stark_trading_os.control.dependencies import ControlDependencies, build_default_dependencies
from stark_trading_os.control.routes import agent as agent_route


def _post(client: TestClient, body: object) -> Response:
    return client.post("/v1/agent/run-review", json=body)


_SCHEMA_INVALID_RESPONSE = (
    b'{"code":"REVIEW_REQUEST_INVALID","message":"The review request is invalid.",'
    b'"run_id":null,"retryable":false,"evidence_id":null,"details":{"field":"body",'
    b'"reason":"SCHEMA_INVALID"}}'
)
_SENSITIVE_INPUT_RESPONSE = (
    b'{"code":"REVIEW_REQUEST_INVALID","message":"The review request is invalid.",'
    b'"run_id":null,"retryable":false,"evidence_id":null,"details":{"field":"question",'
    b'"reason":"SENSITIVE_INPUT_NOT_ACCEPTED"}}'
)


class _ProviderCallSpy:
    def __init__(self) -> None:
        self.calls = 0

    async def review(self) -> RunReviewResponse:
        self.calls += 1
        raise AssertionError("provider must not be called for an invalid request")


class _RouteServiceCallSpy(RunReviewService):
    def __init__(self, provider: _ProviderCallSpy) -> None:
        self.calls = 0
        self.provider = provider

    async def review(
        self,
        request: RunReviewRequest,
        *,
        allow_external: bool,
    ) -> RunReviewResponse:
        self.calls += 1
        assert type(request) is RunReviewRequest
        assert allow_external is True
        return await self.provider.review()


class _ReviewFailureService(RunReviewService):
    def __init__(self, error: BaseException) -> None:
        self._error = error

    async def review(
        self,
        request: RunReviewRequest,
        *,
        allow_external: bool,
    ) -> RunReviewResponse:
        del request, allow_external
        raise self._error


@dataclass(frozen=True)
class _TableSnapshot:
    name: str
    columns: tuple[str, ...]
    rows: tuple[tuple[object, ...], ...]


@dataclass(frozen=True)
class _FileSnapshot:
    run_id: str
    name: str
    content: bytes
    sha256: str
    mode: int


@dataclass(frozen=True)
class _MutationSnapshot:
    total_changes: int
    tables: tuple[_TableSnapshot, ...]
    files: tuple[_FileSnapshot, ...]
    reservations: tuple[object, ...]
    cancellations: tuple[object, ...]
    reconciliations: tuple[str, ...]
    cancellation_request_calls: int
    cancellation_terminate_calls: int


def _app_connection(dependencies: ControlDependencies) -> sqlite3.Connection:
    connection = getattr(dependencies.store, "_connection", None)
    assert type(connection) is sqlite3.Connection
    return connection


def _row_order_key(row: tuple[object, ...]) -> tuple[tuple[str, str], ...]:
    return tuple((type(value).__name__, repr(value)) for value in row)


def _table_snapshots(connection: sqlite3.Connection) -> tuple[_TableSnapshot, ...]:
    table_rows = connection.execute(
        """
        SELECT name
        FROM sqlite_schema
        WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
        ORDER BY name
        """
    ).fetchall()
    snapshots: list[_TableSnapshot] = []
    for table_row in table_rows:
        name = table_row[0]
        assert type(name) is str
        columns = tuple(
            str(column[1])
            for column in connection.execute(
                "SELECT * FROM pragma_table_info(?) ORDER BY cid",
                (name,),
            ).fetchall()
        )
        assert columns
        quoted_name = '"' + name.replace('"', '""') + '"'
        rows = tuple(
            sorted(
                (tuple(row) for row in connection.execute(f"SELECT * FROM {quoted_name}")),
                key=_row_order_key,
            )
        )
        snapshots.append(_TableSnapshot(name=name, columns=columns, rows=rows))
    assert snapshots
    return tuple(snapshots)


def _mutation_snapshot(
    api_harness: ApiHarness,
    dependencies: ControlDependencies,
    connection: sqlite3.Connection,
    *,
    final_run_ids: tuple[str, ...],
) -> _MutationSnapshot:
    assert _app_connection(dependencies) is connection
    scheduler = dependencies.scheduler
    cancellation = dependencies.cancellation
    assert type(scheduler) is RecordingScheduler
    assert type(cancellation) is RecordingCancellation
    assert api_harness.scheduler is scheduler
    assert api_harness.cancellation is cancellation

    files: list[_FileSnapshot] = []
    for run_id in final_run_ids:
        root = api_harness.run_root / run_id
        selected = tuple(sorted(path for path in root.rglob("*") if path.is_file()))
        assert {"seal.json", "run-record.json", "events.ndjson"} <= {
            path.relative_to(root).as_posix() for path in selected
        }
        for path in selected:
            content = path.read_bytes()
            files.append(
                _FileSnapshot(
                    run_id=run_id,
                    name=path.relative_to(root).as_posix(),
                    content=content,
                    sha256=sha256(content).hexdigest(),
                    mode=stat.S_IMODE(path.stat().st_mode),
                )
            )

    return _MutationSnapshot(
        total_changes=connection.total_changes,
        tables=_table_snapshots(connection),
        files=tuple(files),
        reservations=tuple(scheduler.reservations),
        cancellations=tuple(scheduler.cancellations),
        reconciliations=tuple(scheduler.reconciliations),
        cancellation_request_calls=cancellation.request_calls,
        cancellation_terminate_calls=cancellation.terminate_calls,
    )


def _tamper_final_file(api_harness: ApiHarness, run_id: str, name: str) -> None:
    path = api_harness.run_root / run_id / name
    path.chmod(0o600)
    path.write_bytes(path.read_bytes() + b" ")
    path.chmod(0o400)


def _tamper_sqlite_seal(api_harness: ApiHarness, run_id: str) -> None:
    with sqlite3.connect(api_harness.database) as connection:
        row = connection.execute(
            "SELECT seal_digest FROM seals WHERE run_id = ?",
            (run_id,),
        ).fetchone()
        assert row is not None
        digest = str(row[0]).encode("ascii")
    database_bytes = api_harness.database.read_bytes()
    assert database_bytes.count(digest) == 1
    api_harness.database.write_bytes(database_bytes.replace(digest, b"0" * 64, 1))


def _prepare_read_only_case(
    api_harness: ApiHarness,
    case: str,
) -> tuple[dict[str, object], tuple[str, ...], int, str | None]:
    question = "Review it"
    if case == "primary_success":
        (primary,) = seed_cancelled_runs(api_harness, verified=(True,))
        return (
            {"run_id": primary, "compare_run_id": None, "question": question},
            (primary,),
            200,
            None,
        )
    if case == "sensitive_rejection":
        (primary,) = seed_cancelled_runs(api_harness, verified=(True,))
        sensitive = "".join(("api", "_key=", "x" * 12))
        return (
            {"run_id": primary, "compare_run_id": None, "question": sensitive},
            (primary,),
            422,
            "REVIEW_REQUEST_INVALID",
        )
    if case == "primary_unknown":
        return (
            {"run_id": "bt_missing", "compare_run_id": None, "question": question},
            (),
            404,
            "RUN_UNKNOWN",
        )
    if case == "primary_unsealed":
        (primary,) = seed_cancelled_runs(api_harness, verified=(False,))
        return (
            {"run_id": primary, "compare_run_id": None, "question": question},
            (),
            409,
            "RUN_UNSEALED",
        )
    if case == "primary_integrity":
        (primary,) = seed_cancelled_runs(api_harness, verified=(True,))
        _tamper_final_file(api_harness, primary, "events.ndjson")
        return (
            {"run_id": primary, "compare_run_id": None, "question": question},
            (primary,),
            409,
            "RUN_EVIDENCE_INTEGRITY_FAILED",
        )
    if case == "primary_report_integrity":
        primary = seed_verified_terminal_run(
            api_harness,
            run_id="report-integrity",
            terminal_state="COMPLETED",
        )
        _tamper_final_file(api_harness, primary, "reports/metrics.json")
        return (
            {"run_id": primary, "compare_run_id": None, "question": question},
            (primary,),
            409,
            "RUN_EVIDENCE_INTEGRITY_FAILED",
        )
    if case == "compare_success":
        primary, compare = seed_cancelled_runs(api_harness, verified=(True, True))
        return (
            {"run_id": primary, "compare_run_id": compare, "question": "Compare them"},
            (primary, compare),
            200,
            None,
        )
    if case == "compare_unknown":
        (primary,) = seed_cancelled_runs(api_harness, verified=(True,))
        return (
            {"run_id": primary, "compare_run_id": "bt_missing", "question": "Compare them"},
            (primary,),
            404,
            "RUN_UNKNOWN",
        )
    if case == "compare_unsealed":
        primary, compare = seed_cancelled_runs(api_harness, verified=(True, False))
        return (
            {"run_id": primary, "compare_run_id": compare, "question": "Compare them"},
            (primary,),
            409,
            "RUN_UNSEALED",
        )
    if case == "compare_integrity":
        primary, compare = seed_cancelled_runs(api_harness, verified=(True, True))
        _tamper_final_file(api_harness, compare, "seal.json")
        return (
            {"run_id": primary, "compare_run_id": compare, "question": "Compare them"},
            (primary, compare),
            409,
            "RUN_EVIDENCE_INTEGRITY_FAILED",
        )
    if case == "compare_sqlite_integrity":
        primary, compare = seed_cancelled_runs(api_harness, verified=(True, True))
        _tamper_sqlite_seal(api_harness, compare)
        return (
            {"run_id": primary, "compare_run_id": compare, "question": "Compare them"},
            (primary, compare),
            409,
            "RUN_EVIDENCE_INTEGRITY_FAILED",
        )
    raise AssertionError(f"unknown no-mutation case: {case}")


@pytest.mark.parametrize(
    "case",
    (
        "primary_success",
        "sensitive_rejection",
        "primary_unknown",
        "primary_unsealed",
        "primary_integrity",
        "primary_report_integrity",
        "compare_success",
        "compare_unknown",
        "compare_unsealed",
        "compare_integrity",
        "compare_sqlite_integrity",
    ),
)
def test_run_review_never_mutates_control_or_selected_evidence(
    api_harness: ApiHarness,
    case: str,
) -> None:
    body, final_run_ids, expected_status, expected_code = _prepare_read_only_case(
        api_harness,
        case,
    )
    app = create_app(
        dependency_factory=lambda: _dependencies(api_harness),
        web_local_origin=ORIGIN,
        testing=True,
    )

    with TestClient(app, headers={"Origin": ORIGIN}) as client:
        dependencies = app.state.control_dependencies
        assert type(dependencies) is ControlDependencies
        portal = client.portal
        assert portal is not None
        connection = portal.call(_app_connection, dependencies)
        before = portal.call(
            lambda: _mutation_snapshot(
                api_harness,
                dependencies,
                connection,
                final_run_ids=final_run_ids,
            )
        )
        response = _post(client, body)
        after = portal.call(
            lambda: _mutation_snapshot(
                api_harness,
                dependencies,
                connection,
                final_run_ids=final_run_ids,
            )
        )

    assert after == before
    assert response.status_code == expected_status, response.text
    if expected_code is None:
        payload = response.json()
        assert payload["mode"] == "LOCAL_DETERMINISTIC"
        if case == "compare_success":
            assert {item["run_role"] for item in payload["citations"] if item["run_role"]} == {
                "PRIMARY",
                "COMPARE",
            }
            assert {item["run_role"] for item in payload["value_refs"] if item["run_role"]} == {
                "PRIMARY",
                "COMPARE",
            }
    else:
        assert response.json()["code"] == expected_code


@pytest.mark.parametrize(
    "authority",
    (
        "run-record.json",
        "events.ndjson",
        "seal.json",
        "reports/metrics.json",
        "sqlite",
    ),
)
def test_review_maps_evidence_drift_after_the_first_scope_to_integrity_failure(
    api_harness: ApiHarness,
    authority: str,
) -> None:
    run_id = seed_verified_terminal_run(
        api_harness,
        run_id=f"fresh-drift-{authority}",
        terminal_state="COMPLETED",
    )

    class DriftReviewer:
        def __init__(self, mutate: Callable[[], None]) -> None:
            self.calls = 0
            self._mutate = mutate

        async def review(self, _scope: object, _question: str) -> Never:
            self.calls += 1
            self._mutate()
            raise TimeoutError("injected reviewer timeout after evidence drift")

    reviewers: list[DriftReviewer] = []

    def dependency_factory() -> ControlDependencies:
        dependencies = _dependencies(api_harness)

        def mutate() -> None:
            if authority == "sqlite":
                connection = _app_connection(dependencies)
                trigger_names = tuple(
                    str(row[0])
                    for row in connection.execute(
                        "SELECT name FROM sqlite_schema "
                        "WHERE type = 'trigger' AND tbl_name = 'seals'"
                    )
                )
                assert trigger_names
                for trigger_name in trigger_names:
                    quoted_name = '"' + trigger_name.replace('"', '""') + '"'
                    connection.execute(f"DROP TRIGGER {quoted_name}")
                cursor = connection.execute(
                    "UPDATE seals SET seal_digest = ? WHERE run_id = ?",
                    ("0" * 64, run_id),
                )
                assert cursor.rowcount == 1
                connection.commit()
            else:
                _tamper_final_file(api_harness, run_id, authority)

        reviewer = DriftReviewer(mutate)
        reviewers.append(reviewer)
        return replace(
            dependencies,
            run_review_service=RunReviewService(
                builder=IndependentEvidenceScopeBuilder(
                    control_database=api_harness.database,
                    runtime_root=api_harness.runtime_root,
                ),
                reviewer=reviewer,
            ),
        )

    app = create_app(
        dependency_factory=dependency_factory,
        web_local_origin=ORIGIN,
        testing=False,
    )
    with TestClient(app, headers={"Origin": ORIGIN}) as client:
        response = _post(
            client,
            {"run_id": run_id, "compare_run_id": None, "question": "Review it"},
        )

    assert response.status_code == 409
    assert response.json() == {
        "code": "RUN_EVIDENCE_INTEGRITY_FAILED",
        "message": "The selected run evidence failed authoritative integrity verification.",
        "run_id": None,
        "retryable": False,
        "evidence_id": None,
        "details": None,
    }
    assert len(reviewers) == 1
    assert reviewers[0].calls == 1


@pytest.mark.parametrize(
    ("body", "expected_content", "rejected_values"),
    (
        pytest.param(
            {
                "run_id": "bt_missing",
                "compare_run_id": None,
                "question": "Review it",
                "extra": "test-extra-marker",
            },
            _SCHEMA_INVALID_RESPONSE,
            ("test-extra-marker",),
            id="extra-field",
        ),
        pytest.param(
            {"run_id": "bt_missing", "compare_run_id": None, "question": 7},
            _SCHEMA_INVALID_RESPONSE,
            (),
            id="wrong-type",
        ),
        pytest.param(
            {"run_id": "bt_missing", "compare_run_id": None, "question": "   "},
            _SCHEMA_INVALID_RESPONSE,
            ("   ",),
            id="blank",
        ),
        pytest.param(
            {"run_id": "bt_missing", "compare_run_id": None, "question": "q" * 2_001},
            _SCHEMA_INVALID_RESPONSE,
            ("q" * 2_001,),
            id="over-code-point-limit",
        ),
        pytest.param(
            {
                "run_id": "bt_missing",
                "compare_run_id": None,
                "question": "\U0001f600" * 2_049,
            },
            _SCHEMA_INVALID_RESPONSE,
            ("\U0001f600" * 2_049,),
            id="over-utf8-byte-limit",
        ),
        pytest.param(
            {"run_id": "bt_missing", "compare_run_id": None, "question": "left\x1fright"},
            _SENSITIVE_INPUT_RESPONSE,
            ("left\x1fright",),
            id="control-code-point",
        ),
        pytest.param(
            (b'{"run_id":"bt_missing","compare_run_id":null,"question":"left\\ud800right"}'),
            _SENSITIVE_INPUT_RESPONSE,
            ("left\ud800right",),
            id="surrogate-code-point",
        ),
        pytest.param(
            {"run_id": "bt_missing", "compare_run_id": None, "question": "left\u202eright"},
            _SENSITIVE_INPUT_RESPONSE,
            ("left\u202eright",),
            id="bidi-control",
        ),
        pytest.param(
            {
                "run_id": "bt_missing",
                "compare_run_id": None,
                "question": "".join(("api", " key", " = ", "z" * 8)),
            },
            _SENSITIVE_INPUT_RESPONSE,
            ("".join(("api", " key", " = ", "z" * 8)),),
            id="assembled-credential-like",
        ),
    ),
)
def test_invalid_review_matrix_is_fixed_and_never_reaches_service_or_provider(
    api_harness: ApiHarness,
    body: object,
    expected_content: bytes,
    rejected_values: tuple[str, ...],
) -> None:
    provider = _ProviderCallSpy()
    service = _RouteServiceCallSpy(provider)

    def dependencies_with_spies() -> ControlDependencies:
        return replace(_dependencies(api_harness), run_review_service=service)

    app = create_app(
        dependency_factory=dependencies_with_spies,
        web_local_origin=ORIGIN,
        testing=False,
    )
    with TestClient(app, headers={"Origin": ORIGIN}) as client:
        if type(body) is bytes:
            response = client.post(
                "/v1/agent/run-review",
                content=body,
                headers={"Content-Type": "application/json"},
            )
        else:
            response = _post(client, body)
        assert app.state.allow_external_agent_review is True

    assert response.status_code == 422
    assert response.content == expected_content
    assert service.calls == 0
    assert provider.calls == 0
    for rejected in rejected_values:
        raw = rejected.encode("utf-8", errors="surrogatepass")
        escaped = rejected.encode("unicode_escape")
        assert raw not in response.content
        assert escaped not in response.content
        assert sha256(raw).hexdigest().encode("ascii") not in response.content
    if expected_content == _SENSITIVE_INPUT_RESPONSE:
        for framework_key in (
            b'"errors"',
            b'"body"',
            b'"input"',
            b'"msg"',
            b'"ctx"',
            b'"log"',
            b'"echo"',
            b'"digest"',
            b'"sha256"',
        ):
            assert framework_key not in response.content


def test_non_agent_route_retains_the_existing_validation_error_contract(
    client: TestClient,
) -> None:
    response = client.post(
        "/v1/backtests/preflight",
        headers={"Idempotency-Key": "legacy-validation-contract"},
        json={},
    )

    assert response.status_code == 422
    payload = response.json()
    assert payload["code"] == "REQUEST_INVALID"
    assert payload["message"] == "The request is invalid."
    assert payload["run_id"] is None
    assert payload["retryable"] is False
    assert payload["evidence_id"] is None
    assert set(payload["details"]) == {"errors"}
    errors = payload["details"]["errors"]
    assert errors
    assert all(set(error) == {"location", "message"} for error in errors)
    assert all(error["location"][0] == "body" for error in errors)


def test_verified_run_returns_local_review_without_external_reviewer(
    api_harness: ApiHarness,
) -> None:
    seed_verified_cancelled_run(api_harness, run_id="review-cancelled")
    app = create_app(
        dependency_factory=lambda: _dependencies(api_harness),
        web_local_origin=ORIGIN,
        testing=True,
    )

    with TestClient(app, headers={"Origin": ORIGIN}) as client:
        response = _post(
            client,
            {"run_id": "bt_001", "compare_run_id": None, "question": "Review it"},
        )
        assert app.state.allow_external_agent_review is False

    assert response.status_code == 200, response.text
    assert response.json()["mode"] == "LOCAL_DETERMINISTIC"
    assert response.json()["status"] == "AI_REVIEW_NOT_CONFIGURED"


@pytest.mark.parametrize("terminal_state", ("COMPLETED", "FAILED"))
def test_verified_completed_and_failed_runs_are_reviewable(
    api_harness: ApiHarness,
    terminal_state: Literal["COMPLETED", "FAILED"],
) -> None:
    run_id = seed_verified_terminal_run(
        api_harness,
        run_id=terminal_state.lower(),
        terminal_state=terminal_state,
    )
    app = create_app(
        dependency_factory=lambda: _dependencies(api_harness),
        web_local_origin=ORIGIN,
        testing=True,
    )
    with TestClient(app, headers={"Origin": ORIGIN}) as client:
        response = _post(
            client,
            {"run_id": run_id, "compare_run_id": None, "question": "Review it"},
        )

    assert response.status_code == 200, response.text
    assert response.json()["mode"] == "LOCAL_DETERMINISTIC"


def test_unknown_run_and_route_validation_have_closed_error_contract(client: TestClient) -> None:
    unknown = _post(
        client,
        {"run_id": "bt_missing", "compare_run_id": None, "question": "Review it"},
    )
    assert unknown.status_code == 404
    assert unknown.json() == {
        "code": "RUN_UNKNOWN",
        "message": "The selected run does not exist.",
        "run_id": "bt_missing",
        "retryable": False,
        "evidence_id": None,
        "details": None,
    }

    malformed = client.post(
        "/v1/agent/run-review",
        content=b'{"run_id":',
        headers={"Content-Type": "application/json"},
    )
    assert malformed.status_code == 422
    assert malformed.json() == {
        "code": "REVIEW_REQUEST_INVALID",
        "message": "The review request is invalid.",
        "run_id": None,
        "retryable": False,
        "evidence_id": None,
        "details": {"field": "body", "reason": "MALFORMED_JSON"},
    }

    invalid = _post(client, {"run_id": "bt_missing", "question": 7, "extra": "marker"})
    assert invalid.status_code == 422
    assert invalid.json()["details"] == {"field": "body", "reason": "SCHEMA_INVALID"}
    assert "marker" not in invalid.text
    assert "input" not in invalid.text
    assert "ctx" not in invalid.text


@pytest.mark.parametrize(
    ("error", "code", "message"),
    (
        (RunReviewBusy("busy"), "RUN_REVIEW_BUSY", "A run review is already in progress."),
        (
            RunReviewDeadlineExceeded("deadline"),
            "RUN_REVIEW_TIMED_OUT",
            "The run review exceeded its server deadline.",
        ),
    ),
)
def test_review_busy_and_deadline_use_the_existing_closed_409_error_schema(
    api_harness: ApiHarness,
    error: BaseException,
    code: str,
    message: str,
) -> None:
    app = create_app(
        dependency_factory=lambda: replace(
            _dependencies(api_harness),
            run_review_service=_ReviewFailureService(error),
        ),
        web_local_origin=ORIGIN,
        testing=True,
    )
    with TestClient(app, headers={"Origin": ORIGIN}) as client:
        response = _post(
            client,
            {"run_id": "bt_001", "compare_run_id": None, "question": "Review it"},
        )

    assert response.status_code == 409
    assert response.json() == {
        "code": code,
        "message": message,
        "run_id": None,
        "retryable": True,
        "evidence_id": None,
        "details": None,
    }


def test_compare_unknown_reports_the_exact_missing_identifier(
    api_harness: ApiHarness,
) -> None:
    seed_verified_cancelled_run(api_harness, run_id="compare-primary")
    run_id = "bt_001"
    app = create_app(
        dependency_factory=lambda: _dependencies(api_harness),
        web_local_origin=ORIGIN,
        testing=True,
    )
    with TestClient(app, headers={"Origin": ORIGIN}) as client:
        response = _post(
            client,
            {"run_id": run_id, "compare_run_id": "bt_missing_compare", "question": "Compare"},
        )
    assert response.status_code == 404
    assert response.json()["run_id"] == "bt_missing_compare"


def test_unsealed_run_is_rejected_without_attributing_primary_or_compare(
    api_harness: ApiHarness,
) -> None:
    run_id = seed_hidden_cancelled_run(api_harness, run_id="unsealed-review")
    app = create_app(
        dependency_factory=lambda: _dependencies(api_harness),
        web_local_origin=ORIGIN,
        testing=True,
    )
    with TestClient(app, headers={"Origin": ORIGIN}) as client:
        response = _post(
            client,
            {"run_id": run_id, "compare_run_id": None, "question": "Review it"},
        )
    assert response.status_code == 409
    assert response.json()["code"] == "RUN_UNSEALED"
    assert response.json()["run_id"] is None


@pytest.mark.parametrize("authority", ("run-record.json", "events.ndjson", "seal.json", "sqlite"))
def test_authority_drift_is_rejected_without_rewriting_evidence(
    api_harness: ApiHarness,
    authority: str,
) -> None:
    seed_verified_cancelled_run(api_harness, run_id=f"drift-{authority}")
    run_id = "bt_001"
    root = api_harness.run_root / run_id
    selected = tuple(root / name for name in ("run-record.json", "events.ndjson", "seal.json"))
    if authority == "sqlite":
        _tamper_sqlite_seal(api_harness, run_id)
    else:
        target = root / authority
        target.chmod(0o600)
        target.write_bytes(target.read_bytes() + b" ")
        target.chmod(0o400)
    before = tuple(
        (path.read_bytes(), sha256(path.read_bytes()).hexdigest(), path.stat().st_mode)
        for path in selected
    )

    app = create_app(
        dependency_factory=lambda: _dependencies(api_harness),
        web_local_origin=ORIGIN,
        testing=True,
    )
    with TestClient(app, headers={"Origin": ORIGIN}) as client:
        response = _post(
            client,
            {"run_id": run_id, "compare_run_id": None, "question": "Review it"},
        )
    after = tuple(
        (path.read_bytes(), sha256(path.read_bytes()).hexdigest(), path.stat().st_mode)
        for path in selected
    )
    assert response.status_code == 409
    assert response.json()["code"] == "RUN_EVIDENCE_INTEGRITY_FAILED"
    assert response.json()["run_id"] is None
    assert after == before


def test_sensitive_review_validation_never_echoes_or_hashes_input(client: TestClient) -> None:
    marker = "".join(("api", "_key=", "x" * 12))
    response = _post(
        client,
        {"run_id": "bt_missing", "compare_run_id": None, "question": marker},
    )

    assert response.status_code == 422
    assert response.json()["details"] == {
        "field": "question",
        "reason": "SENSITIVE_INPUT_NOT_ACCEPTED",
    }
    assert marker not in response.text
    for forbidden in ("input", "body", "msg", "ctx"):
        assert forbidden not in response.text


def test_raw_classifier_calls_only_for_exact_dict_and_string(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class DictSubclass(dict[str, object]):
        pass

    class StringSubclass(str):
        pass

    calls: list[str] = []
    monkeypatch.setattr(agent_route, "validate_untrusted_question", calls.append)
    values: tuple[object, ...] = (
        [],
        {"question": 7},
        DictSubclass(question="dict subclass"),
        {"question": StringSubclass("string subclass")},
        {"question": "safe"},
        dict(question="also safe"),
    )

    for value in values:
        assert agent_route._classify_review_request(value) is value

    assert calls == ["safe", "also safe"]


def test_raw_classifier_propagates_sensitive_subclass_and_unexpected_error_by_identity(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    derived_type = type("DerivedSensitiveQuestionRejected", (SensitiveQuestionRejected,), {})
    for error in (derived_type(), RuntimeError("classifier defect")):

        def reject(_question: str, *, current: BaseException = error) -> str:
            raise current

        monkeypatch.setattr(agent_route, "validate_untrusted_question", reject)
        with pytest.raises(type(error)) as captured:
            agent_route._classify_review_request({"question": "safe"})
        assert captured.value is error


def test_testing_mode_blocks_injected_reviewer_and_missing_service_is_not_fallback(
    api_harness: ApiHarness,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("OPENAI_AGENT_MODEL", "gpt-5.6")
    monkeypatch.setenv("OPENAI_API_KEY", "not-a-real-key")
    seed_verified_cancelled_run(api_harness, run_id="testing-review")

    class Reviewer:
        calls = 0

        async def review(self, *_args: object, **_kwargs: object) -> object:
            self.calls += 1
            raise AssertionError("testing must never call the reviewer")

    reviewer = Reviewer()

    def injected_dependencies() -> ControlDependencies:
        dependencies = _dependencies(api_harness)
        service = RunReviewService(
            builder=IndependentEvidenceScopeBuilder(
                control_database=api_harness.database,
                runtime_root=api_harness.runtime_root,
            ),
            reviewer=reviewer,  # type: ignore[arg-type]
        )
        return replace(dependencies, run_review_service=service)

    app = create_app(
        dependency_factory=injected_dependencies,
        web_local_origin=ORIGIN,
        testing=True,
    )
    with TestClient(app, headers={"Origin": ORIGIN}) as client:
        response = _post(
            client,
            {"run_id": "bt_001", "compare_run_id": None, "question": "Review it"},
        )
    assert response.status_code == 200
    assert app.state.allow_external_agent_review is False
    assert reviewer.calls == 0

    def missing_dependencies() -> ControlDependencies:
        return replace(_dependencies(api_harness), run_review_service=None)

    missing_app = create_app(
        dependency_factory=missing_dependencies,
        web_local_origin=ORIGIN,
        testing=True,
    )
    with TestClient(missing_app, headers={"Origin": ORIGIN}) as missing_client:
        with pytest.raises(RuntimeError, match="Run review service is unavailable"):
            _post(
                missing_client,
                {"run_id": "bt_001", "compare_run_id": None, "question": "Review it"},
            )


def test_startup_validates_configured_model_even_without_key(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("OPENAI_AGENT_MODEL", "provider/model")
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)

    with pytest.raises(ValueError):
        build_default_dependencies(tmp_path)


def test_startup_rejects_explicit_empty_model_even_without_key(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("OPENAI_AGENT_MODEL", "")
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)

    with pytest.raises(
        ValueError,
        match="model name must be a provider-prefix-free identifier",
    ):
        build_default_dependencies(tmp_path)


@pytest.mark.parametrize("key_value", (None, ""))
def test_startup_keeps_reviewer_unconfigured_when_key_is_absent_or_empty(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    key_value: str | None,
) -> None:
    monkeypatch.setenv("OPENAI_AGENT_MODEL", "gpt-5.6")
    if key_value is None:
        monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    else:
        monkeypatch.setenv("OPENAI_API_KEY", key_value)

    dependencies = build_default_dependencies(tmp_path)
    try:
        assert dependencies.run_review_service is not None
        assert dependencies.run_review_service._reviewer is None
    finally:
        dependencies.store.close()


def test_startup_constructs_reviewer_only_from_valid_model_and_key_presence(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    credential = "".join(("sk-", "x" * 20))
    observed: list[str] = []
    sentinel = object()

    def reviewer_factory(*, model_name: str) -> object:
        observed.append(model_name)
        return sentinel

    monkeypatch.setenv("OPENAI_AGENT_MODEL", "gpt-5.6")
    monkeypatch.setenv("OPENAI_API_KEY", credential)
    monkeypatch.setattr(dependencies_module, "RunReviewer", reviewer_factory)

    dependencies = build_default_dependencies(tmp_path)
    try:
        assert observed == ["gpt-5.6"]
        assert dependencies.run_review_service is not None
        assert dependencies.run_review_service._reviewer is sentinel
        assert credential not in repr(dependencies)
        assert credential not in repr(vars(dependencies.run_review_service))
    finally:
        dependencies.store.close()
