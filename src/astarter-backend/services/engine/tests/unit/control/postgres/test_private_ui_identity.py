"""PRIVATE UI v2 identity isolation; only explicitly owned local PG fixtures."""

import importlib
import time
from contextlib import contextmanager
from dataclasses import replace
from unittest.mock import patch
from uuid import uuid4

import pytest
from psycopg import sql
from pydantic import ValidationError

from stark_trading_os.control.postgres.access import AccessRejected
from stark_trading_os.control.postgres.private_research_inputs import (
    UI_PERMISSIONS as CONTRACT_UI_PERMISSIONS,
)
from stark_trading_os.control.postgres.private_research_inputs import issuer_input
from stark_trading_os.control.postgres.private_research_issuer import PrivateIssuerRepository
from stark_trading_os.control.postgres.private_research_repository import PrivateRuntimeRepository
from tests.unit.control.postgres import test_private_research_issuer as issuer_helpers
from tests.unit.control.postgres import test_private_research_migration as base
from tests.unit.control.postgres.test_private_research_inputs import (
    ADDRESS,
    AT,
    challenge,
    session,
)
from tests.unit.control.postgres.test_private_research_migration import db as db
from tests.unit.control.postgres.test_private_research_migration import native
from tests.unit.control.postgres.test_private_research_pool import target as cold_target
from tests.unit.control.postgres.test_private_research_repository import lease, pool_for, scope

PROFILE = "private-ui-v2"
PROFILE_LINE = "- urn:astarter:permission-profile:private-ui-v2"
UI_PERMISSIONS = [
    "research:analyze",
    "notifications:read",
    "notifications:write",
    "workspace:read",
    "workspace:write",
]


def payload(operation, *, version=2):
    if operation == "auth/challenge/issue":
        data = challenge()
    elif operation == "auth/session/issue":
        data = session() | {"permissions": UI_PERMISSIONS if version == 2 else ["research:analyze"]}
    else:
        data = {
            "challengeHash": "a" * 64,
            "nonce": "b" * 64,
            "address": ADDRESS,
            "chain": 56,
            "message": "Owned SIWE fixture\nResources:\n" + PROFILE_LINE,
            "now": AT,
        }
    return data | ({"authVersion": 2, "permissionProfile": PROFILE} if version == 2 else {})


OPERATIONS = (
    "auth/challenge/issue",
    "auth/challenge/prepare",
    "auth/challenge/consume",
    "auth/session/issue",
)


@pytest.mark.parametrize("operation", OPERATIONS)
def test_v2_fixed_profile_is_supported(operation):
    data = payload(operation)
    parsed = issuer_input(operation, data)
    result = parsed.model_dump(mode="json", by_alias=True)
    assert result["authVersion"] == 2
    assert result["permissionProfile"] == PROFILE
    if operation == "auth/session/issue":
        assert result["permissions"] == UI_PERMISSIONS


@pytest.mark.parametrize("operation", OPERATIONS)
@pytest.mark.parametrize("bad_version", [True, False, 2.0, 1.0, "2", 0, 3])
def test_auth_version_rejects_bool_float_string_and_unknown(operation, bad_version):
    with pytest.raises(ValidationError):
        issuer_input(operation, payload(operation) | {"authVersion": bad_version})


@pytest.mark.parametrize("operation", OPERATIONS)
@pytest.mark.parametrize(
    "change",
    [
        {"permissionProfile": "admin"},
        {"permissionProfile": "research-v1"},
        {"authVersion": 1},
        {"owner": ADDRESS},
        {"subjectId": "forged"},
    ],
)
def test_profile_pair_and_client_owned_identity_are_rejected(operation, change):
    with pytest.raises(ValidationError):
        issuer_input(operation, payload(operation) | change)


@pytest.mark.parametrize(
    "permissions",
    [
        ["research:analyze"],
        UI_PERMISSIONS[:-1],
        UI_PERMISSIONS + ["admin"],
        UI_PERMISSIONS + [UI_PERMISSIONS[0]],
        list(reversed(UI_PERMISSIONS)),
    ],
)
def test_v2_permissions_are_exact_and_cannot_be_client_expanded(permissions):
    with pytest.raises(ValidationError):
        issuer_input(
            "auth/session/issue", payload("auth/session/issue") | {"permissions": permissions}
        )


def test_v1_wire_stays_unchanged_and_research_only():
    assert (
        issuer_input("auth/challenge/issue", challenge()).model_dump(mode="json", by_alias=True)
        == challenge()
    )
    assert (
        issuer_input("auth/session/issue", session()).model_dump(mode="json", by_alias=True)
        == session()
    )
    with pytest.raises(ValidationError):
        issuer_input("auth/session/issue", session() | {"permissions": UI_PERMISSIONS})


def test_exported_ui_permissions_match_the_frozen_five_capabilities():
    assert list(CONTRACT_UI_PERMISSIONS) == UI_PERMISSIONS


def test_target_schema_version_defaults_to_v1_and_supports_v2():
    assert cold_target().schema_version == 1
    assert replace(cold_target(), schema_version=2).schema_version == 2


@pytest.mark.parametrize("version", [True, False, 1.0, 2.0, 3.0, "2", 0, 4, None])
def test_target_schema_version_rejects_coercion_and_unknown(version):
    with pytest.raises((ValueError, AccessRejected)):
        replace(cold_target(), schema_version=version)


def _upgrade(owner, target):
    module = importlib.import_module("stark_trading_os.control.postgres.private_ui_migration")
    return module.upgrade_private_ui(owner, target=target)


@pytest.fixture(scope="module")
def pg():
    # Keep the unchanged owned harness's artifacts inside this author's leased prefix.
    evidence = base.TASK / ("ui-identity-test-native-" + uuid4().hex)
    evidence.mkdir(mode=0o700)
    with patch.object(base, "TASK", evidence), base.cluster() as owned:
        yield owned


@contextmanager
def _issuer(target):
    pool = pool_for(target, "issuer")
    try:
        pool.open()
        yield PrivateIssuerRepository(pool)
    finally:
        pool.close()
        assert pool._pool.closed


def _challenge(repo, suffix, version):
    if version == 1:
        return issuer_helpers.challenge(repo, suffix)
    now = time.time_ns() // 1_000_000
    record = payload("auth/challenge/issue") | {
        "challengeHash": issuer_helpers.hashed(suffix),
        "nonce": issuer_helpers.hashed(suffix + "nonce"),
        "issuedAt": now,
        "expires": now + 300000,
    }
    saved = repo.invoke("auth/challenge/issue", record, None)
    assert saved is not None
    assert saved["authVersion"] == 2 and saved["permissionProfile"] == PROFILE
    return saved


def _binding(record, version):
    bound = issuer_helpers.binding(record)
    if version == 2:
        bound |= {
            "authVersion": 2,
            "permissionProfile": PROFILE,
            "message": "Owned synthetic SIWE\nResources:\n" + PROFILE_LINE,
        }
    return bound


def _session_args(bound, claim, suffix, version):
    data = issuer_helpers.session_args(bound, claim, suffix)
    if version == 2:
        data |= {"authVersion": 2, "permissionProfile": PROFILE, "permissions": UI_PERMISSIONS}
    return data


@pytest.fixture
def upgraded(db):
    pg, owner, target = db
    target2 = replace(target, schema_version=2)
    _upgrade(owner, target2)
    return pg, owner, target2


_TABLES = (
    "leases",
    "challenges",
    "sessions",
    "global_budget",
    "policies",
    "requests",
    "cost_events",
)


def _rows(owner):
    return {
        table: owner.execute(
            sql.SQL("SELECT * FROM astarter_private.{}").format(sql.Identifier(table))
        ).fetchall()
        for table in _TABLES
    }


def _preserved(before, owner):
    after = _rows(owner)
    for table, rows in before.items():
        assert len(rows) == len(after[table]), table
        for row in rows:
            assert (
                sum(
                    all(candidate[key] == value for key, value in row.items())
                    for candidate in after[table]
                )
                == 1
            ), table


def _roles(owner, target):
    names = [getattr(target, kind) for kind in ("owner", "runtime", "issuer", "cost")]
    roles = owner.execute(
        "SELECT oid,rolname,rolcanlogin,rolinherit,rolsuper,rolcreatedb,rolcreaterole,"
        "rolreplication,rolbypassrls,rolconfig,rolconnlimit,rolvaliduntil "
        "FROM pg_roles WHERE rolname=ANY(%s) ORDER BY rolname",
        (names,),
    ).fetchall()
    parents = owner.execute(
        "SELECT member,roleid,admin_option,inherit_option,set_option FROM pg_auth_members "
        "WHERE member=ANY(%s::oid[]) ORDER BY member,roleid",
        ([r["oid"] for r in roles],),
    ).fetchall()
    return roles, parents


@native
def test_migration_preserves_sessions_requests_holds_costs_and_roles(db):
    _, owner, target = db
    first, billed = base.accounting(db, "a"), base.accounting(db, "b")
    with _issuer(target) as old_issuer:
        old_unconsumed = issuer_helpers.challenge(old_issuer, "pre-upgrade-unconsumed")
    owner.execute("UPDATE astarter_private.global_budget SET held_microusd=41780")
    with base.app(db, "cost") as cost:
        assert cost.execute(
            "SELECT astarter_private.settle_cost(%s,%s,%s,%s,%s,%s) AS settled",
            ("synthetic-ui-ledger", billed["subject"], billed["subject"], "request-001", 1234, 100),
        ).fetchone() == {"settled": True}
    before, role_before = _rows(owner), _roles(owner, target)
    assert before["global_budget"][0]["held_microusd"] == 20890
    assert before["global_budget"][0]["spent_microusd"] == 1234
    assert len(before["cost_events"]) == 1
    target2 = replace(target, schema_version=2)
    _upgrade(owner, target2)
    _preserved(before, owner)
    assert _roles(owner, target2) == role_before
    assert owner.execute("SELECT schema_version FROM astarter_private.metadata").fetchone() == {
        "schema_version": 2
    }
    _upgrade(owner, target2)
    _preserved(before, owner)
    configured = lease(target2, first["now"] + 60000)
    pool = pool_for(target2, "runtime")
    try:
        pool.open()
        repo = PrivateRuntimeRepository(pool, lease=configured)
        principal = repo.invoke(
            "session/resolve",
            scope(configured) | {"tokenDigest": first["token"], "now": 0},
            first["token"],
        )
        assert principal["permissions"] == ["research:analyze"]
        assert "authVersion" not in principal and "permissionProfile" not in principal
        held = repo.invoke(
            "research/get",
            scope(configured)
            | {
                "tenantId": first["subject"],
                "subjectId": first["subject"],
                "scopeId": first["subject"],
                "requestId": "request-001",
            },
            first["token"],
        )
        assert held["state"] == "pending" and held["settledTokens"] is None
        assert held["fingerprint"] == "f" * 64
    finally:
        pool.close()
        assert pool._pool.closed
    with _issuer(target2) as upgraded_issuer:
        assert (
            upgraded_issuer.invoke("auth/challenge/prepare", _binding(old_unconsumed, 2), None)
            is None
        )
        original = _binding(old_unconsumed, 1)
        assert upgraded_issuer.invoke("auth/challenge/prepare", original, None)
        consumed = upgraded_issuer.invoke("auth/challenge/consume", original, None)
        issued = upgraded_issuer.invoke(
            "auth/session/issue", _session_args(original, consumed, "legacy-after-upgrade", 1), None
        )
        assert issued["permissions"] == ["research:analyze"]
        assert "authVersion" not in issued and "permissionProfile" not in issued


@native
def test_v2_issue_resolve_and_challenge_revoke_keep_exact_profile(upgraded):
    _, owner, target = upgraded
    with _issuer(target) as repo:
        record = _challenge(repo, "ui-roundtrip", 2)
        bound = _binding(record, 2)
        assert repo.invoke("auth/challenge/prepare", bound, None)["permissionProfile"] == PROFILE
        consumed = repo.invoke("auth/challenge/consume", bound, None)
        assert consumed["challenge"]["authVersion"] == 2
        data = _session_args(bound, consumed, "ui-token", 2)
        issued = repo.invoke("auth/session/issue", data, None)
        assert issued["authVersion"] == 2 and issued["permissionProfile"] == PROFILE
        assert issued["permissions"] == UI_PERMISSIONS
        assert issued["subjectId"] == issued["scopeId"] == "wallet:56:" + bound["address"].lower()
        key = {"tokenHash": data["tokenHash"], "now": 0}
        assert repo.invoke("auth/session/resolve", key, None) == issued
        configured = lease(target, issued["issuedAt"] + 120000)
        owner.execute(
            "INSERT INTO astarter_private.leases VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)",
            (
                configured.lease_id,
                target.target_id,
                target.database,
                target.runtime,
                target.profile.value,
                configured.audience,
                configured.model,
                configured.budget_id,
                issued["issuedAt"] - 1000,
                configured.expires_at,
            ),
        )
        pool = pool_for(target, "runtime")
        try:
            pool.open()
            with pool.transaction() as connection:
                principal = connection.execute(
                    "SELECT * FROM astarter_private.resolve_session(%s,%s)",
                    (data["tokenHash"], "astarter-research"),
                ).fetchone()
            assert principal["permissions"] == UI_PERMISSIONS
            assert principal["subject_id"] == issued["subjectId"]
            wire = PrivateRuntimeRepository(pool, lease=configured).invoke(
                "session/resolve",
                scope(configured) | {"tokenDigest": data["tokenHash"], "now": 0},
                data["tokenHash"],
            )
            assert wire["authVersion"] == 2 and wire["permissionProfile"] == PROFILE
            assert wire["permissions"] == UI_PERMISSIONS
            assert wire["subjectId"] == wire["tenantId"] == wire["scopeId"] == issued["subjectId"]
        finally:
            pool.close()
        assert repo.invoke(
            "auth/challenge/revoke", {"challengeHash": record["challengeHash"], "now": 0}, None
        )
        assert repo.invoke("auth/session/resolve", key, None) is None
    assert owner.execute("SELECT count(*) n FROM astarter_private.global_budget").fetchone() == {
        "n": 0
    }


@native
@pytest.mark.parametrize("stored,wrong", [(1, 2), (2, 1)])
def test_prepare_consume_issue_cannot_cross_challenge_versions(upgraded, stored, wrong):
    _, _, target = upgraded
    with _issuer(target) as repo:
        record = _challenge(repo, "version-isolation", stored)
        bound = _binding(record, stored)
        wrong_bound = _binding(record, wrong)
        assert repo.invoke("auth/challenge/prepare", wrong_bound, None) is None
        assert repo.invoke("auth/challenge/prepare", bound, None) is not None
        assert repo.invoke("auth/challenge/consume", wrong_bound, None) is None
        consumed = repo.invoke("auth/challenge/consume", bound, None)
        assert consumed is not None
        wrong_issue = _session_args(bound, consumed, "wrong-version-token", wrong)
        assert repo.invoke("auth/session/issue", wrong_issue, None) is None
        correct = _session_args(bound, consumed, "correct-version-token", stored)
        issued = repo.invoke("auth/session/issue", correct, None)
        assert issued is not None
        assert issued["permissions"] == (UI_PERMISSIONS if stored == 2 else ["research:analyze"])


@native
@pytest.mark.parametrize(
    "message",
    [
        "Owned SIWE with no resource",
        "prefix " + PROFILE_LINE,
        PROFILE_LINE + " trailing",
        "- urn:astarter:permission-profile:research-v1",
    ],
)
def test_v2_prepare_requires_an_independent_exact_resource_line(upgraded, message):
    _, _, target = upgraded
    with _issuer(target) as repo:
        record = _challenge(repo, "line-boundary", 2)
        bound = _binding(record, 2)
        try:
            result = repo.invoke("auth/challenge/prepare", bound | {"message": message}, None)
        except ValidationError:
            result = None
        assert result is None
        assert repo.invoke("auth/challenge/prepare", bound, None) is not None


@native
def test_upgrade_rejects_unknown_catalog_without_erasing_v1_identity(db):
    _, owner, target = db
    base.accounting(db)
    before = _rows(owner)
    owner.execute("CREATE TABLE public.unexpected_ui_migration_marker(id integer)")
    with pytest.raises(AccessRejected):
        _upgrade(owner, replace(target, schema_version=2))
    _preserved(before, owner)
    assert owner.execute("SELECT schema_version FROM astarter_private.metadata").fetchone() == {
        "schema_version": 1
    }


@native
def test_upgrade_requires_exact_local_v2_owner_target(db):
    _, owner, target = db
    before = base.m.private_catalog_digest(owner)
    wrong = (
        target,
        replace(target, schema_version=2, database="other_synthetic_database"),
        replace(target, schema_version=2, owner="other_synthetic_owner"),
        replace(
            target,
            schema_version=2,
            profile=base.TargetProfile.NEON_PG17_V1,
            host="ep-ui-synthetic.ap-southeast-1.aws.neon.tech",
        ),
    )
    for candidate in wrong:
        with pytest.raises((AccessRejected, ValueError)):
            _upgrade(owner, candidate)
    assert base.m.private_catalog_digest(owner) == before
    assert owner.execute("SELECT schema_version FROM astarter_private.metadata").fetchone() == {
        "schema_version": 1
    }
