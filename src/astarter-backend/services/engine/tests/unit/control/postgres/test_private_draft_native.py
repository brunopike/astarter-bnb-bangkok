"""R3 uses existing PRIVATE roles/pool on newly owned Unix-only synthetic PG17."""

import copy
import json
import subprocess
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from hashlib import sha256
from pathlib import Path
from threading import Barrier
from unittest.mock import patch
from uuid import uuid4

import psycopg
import pytest
from fastapi.testclient import TestClient

from stark_trading_os.control.postgres import private_draft_repository as drafts
from stark_trading_os.control.postgres.access import AccessRejected
from stark_trading_os.control.postgres.pool import CommitUnknown
from stark_trading_os.control.postgres.private_draft_migration import upgrade_private_drafts
from stark_trading_os.control.postgres.private_research_issuer import PrivateIssuerRepository
from stark_trading_os.control.postgres.private_research_repository import PrivateRuntimeRepository
from stark_trading_os.control.postgres.private_ui_repository import PrivateUIRepository
from stark_trading_os.control.private_research_rpc import (
    PrivateRPCError,
    create_private_research_app,
)
from tests.unit.control.postgres import test_private_research_migration as base
from tests.unit.control.postgres import test_private_ui_native as ui_native
from tests.unit.control.postgres.test_private_draft_contracts import fields, filled, report_row
from tests.unit.control.postgres.test_private_research_migration import db as db
from tests.unit.control.postgres.test_private_research_migration import native
from tests.unit.control.postgres.test_private_research_repository import (
    claim_payload,
    finish_payload,
    pool_for,
    scope,
)

legacy_live = ui_native.live


@pytest.fixture(scope="module")
def pg():
    evidence = base.TASK / ("r3-native-" + uuid4().hex)
    evidence.mkdir(mode=0o700)
    with patch.object(base, "TASK", evidence), base.cluster() as owned:
        yield owned


def completed(live, who="alice"):
    repo, user, configured = live["research"], live["users"][who], live["lease"]
    claimed = repo.invoke("research/claim", claim_payload(repo, user, configured), user["digest"])
    now = (
        live["owner"]
        .execute("SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint AS n")
        .fetchone()["n"]
    )
    payload = finish_payload(user, configured, claimed["claimToken"])
    payload["result"] = report_row(now + 1000)["result"]
    result = repo.invoke("research/finish", payload, user["digest"])
    assert result["state"] == "complete"
    return payload["requestId"]


@pytest.fixture
def live(legacy_live):
    old = legacy_live
    source_id = completed(old)
    old_state = old["ui"].invoke(
        "workspace/state", scope(old["lease"]), old["users"]["alice"]["digest"]
    )
    old_receipt = old["ui"].invoke(
        "workspace/save",
        scope(old["lease"])
        | {
            "requestId": "before-migration-01",
            "baseRevision": old_state["revision"],
            **{key: old_state[key] for key in ("preferences", "drafts", "selectedDraftId")},
        },
        old["users"]["alice"]["digest"],
    )
    old["pool"].close()
    old["issuer"]._pool.close()
    target = replace(old["target"], schema_version=3)
    upgrade_private_drafts(old["owner"], target=target)
    runtime, issuer = pool_for(target, "runtime"), pool_for(target, "issuer")
    try:
        runtime.open()
        issuer.open()
        yield old | {
            "target": target,
            "pool": runtime,
            "issuer": PrivateIssuerRepository(issuer),
            "research": PrivateRuntimeRepository(runtime, lease=old["lease"]),
            "source_id": source_id,
            "old_receipt": old_receipt,
        }
    finally:
        runtime.close()
        issuer.close()


def invoke(live, operation, payload=None, who="alice"):
    return live["research"].invoke(
        operation,
        scope(live["lease"]) | (payload or {}),
        live["users"][who]["digest"],
    )


def preview_input(live, values=None):
    return {
        "draftId": "draft-01",
        "sourceRequestId": live["source_id"],
        "fields": fields() if values is None else values,
    }


def prepare(live, values=None, request="draft-save-01"):
    args = preview_input(live, values)
    p = invoke(live, "drafts/preview", args)
    return args | {
        "requestId": request,
        **{key: p[key] for key in ("expectedRevision", "workspaceRevision", "proposalRevision")},
    }, p


@native
def test_native_source_preview_adopt_replay_preserves_nulls_without_extra_budget(live):
    owner = live["owner"]
    before = owner.execute("SELECT * FROM astarter_private.global_budget").fetchall()
    args, p = prepare(live)
    assert p["current"] is None and p["expectedRevision"] == 0 and not p["listed"]
    first = invoke(live, "drafts/adopt", args)
    assert first["draft"]["content"]["fields"] == fields()
    assert first["draft"]["revision"] == 1
    assert invoke(live, "drafts/get", {"draftId": "draft-01"}) == first["draft"]
    assert invoke(live, "drafts/request", {"requestId": args["requestId"]}) == first
    assert invoke(live, "drafts/adopt", args) == first
    assert owner.execute("SELECT * FROM astarter_private.global_budget").fetchall() == before
    assert (
        owner.execute("SELECT count(*) AS n FROM astarter_private.draft_versions").fetchone()["n"]
        == 1
    )
    assert invoke(live, "workspace/state")["drafts"] == [
        {"id": "draft-01", "strategyId": "S01", "name": fields()["name"]}
    ]


@native
def test_native_pg_finish_node_projection_and_draft_keep_independent_clocks(live):
    frontend = Path("/Users/mac/Documents/AI Space/Developer/交易大法/工程/hive-motion-lab")
    for name, digest in (
        (
            "research-analysis-service.mjs",
            "f29b8a4f23911f584698c724d2b49a4ef8169a779ecd6b6af55c38101cc597a8",
        ),
        (
            "research-job-client.mjs",
            "8f22fa039353d5ef169c5ccb556b54b0dc4e0232cb93cbd628f55615bcce9c27",
        ),
    ):
        assert sha256((frontend / name).read_bytes()).hexdigest() == digest
    repo, user, configured = live["research"], live["users"]["alice"], live["lease"]
    claim = claim_payload(repo, user, configured, request="clock-request-01")
    acquired = repo.invoke("research/claim", claim, user["digest"])
    # Synthetic Node clock leads PG by one second; no host clock or source time is changed.
    node_created = (
        live["owner"]
        .execute("SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint AS n")
        .fetchone()["n"]
        + 1000
    )
    payload = finish_payload(user, configured, acquired["claimToken"])
    payload |= {
        "requestId": claim["requestId"],
        "result": report_row(node_created + 1000)["result"],
    }
    finished = repo.invoke("research/finish", payload, user["digest"])
    original = (
        live["owner"]
        .execute(
            "SELECT * FROM astarter_private.requests WHERE request_id=%s", (claim["requestId"],)
        )
        .fetchone()
    )
    assert original["created_at_ms"] <= original["finished_at_ms"] < node_created
    assert original["result"] == payload["result"] and finished["state"] == "complete"
    # A bounded real wait lets PG catch up; the original stored clocks remain frozen.
    time.sleep(1.1)
    now = (
        live["owner"]
        .execute("SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint AS n")
        .fetchone()["n"]
    )
    assert node_created <= now
    get_args = {
        key: claim[key]
        for key in (
            "leaseId",
            "targetId",
            "audience",
            "tenantId",
            "subjectId",
            "scopeId",
            "requestId",
        )
    }
    record = repo.invoke("research/get", get_args, user["digest"])
    projected = subprocess.run(
        [
            "/usr/local/bin/node",
            "--input-type=module",
            "-e",
            """
import {createResearchAnalysisService} from './research-analysis-service.mjs';
import {validateResearchJob} from './research-job-client.mjs';
let input=''; for await (const chunk of process.stdin) input+=chunk;
const {record,now}=JSON.parse(input);
const deny=()=>{throw Error('UNEXPECTED_MODEL_OR_PROVIDER_OR_MUTATION');};
globalThis.fetch=deny;
const service=createResearchAnalysisService({
 model:{configured:true,model:'openai/gpt-4.1-mini',generate:deny},
 authorize:()=>({subjectId:record.subjectId,scopeId:record.scopeId,
  expiresAt:now+60000,permissions:['research:analyze']}),
 admission:deny,loadEvidence:deny,now:()=>now,
 store:{get:()=>record,claim:deny,finish:deny}
});
const body=await service.get({},record.requestId);
await validateResearchJob(body,{requestId:record.requestId,symbols:['BTC'],now});
process.stdout.write(JSON.stringify(body));
""",
        ],
        cwd=frontend,
        input=json.dumps({"record": record, "now": now}),
        text=True,
        capture_output=True,
        timeout=15,
        check=True,
    )
    public = json.loads(projected.stdout)
    assert public["result"] == original["result"] and public["fresh"]
    assert public["createdAt"] == original["created_at_ms"]
    before = live["owner"].execute("SELECT * FROM astarter_private.global_budget").fetchall()
    live = live | {"source_id": claim["requestId"]}
    args, preview = prepare(live)
    source = preview["proposal"]["source"]
    assert source["createdAt"] == node_created
    assert source["validUntil"] == public["result"]["validUntil"]
    first = invoke(live, "drafts/adopt", args)
    assert first["draft"]["content"]["source"] == source
    assert invoke(live, "drafts/adopt", args) == first
    assert (
        live["owner"].execute("SELECT * FROM astarter_private.global_budget").fetchall() == before
    )
    assert (
        live["owner"]
        .execute(
            "SELECT * FROM astarter_private.requests WHERE request_id=%s", (claim["requestId"],)
        )
        .fetchone()
        == original
    )


@native
def test_native_wrong_owner_has_no_source_draft_or_original_receipt(live):
    args, _ = prepare(live, filled())
    invoke(live, "drafts/adopt", args)
    for method, payload in (
        ("drafts/get", {"draftId": "draft-01"}),
        ("drafts/request", {"requestId": args["requestId"]}),
    ):
        assert invoke(live, method, payload, "bob") is None
    with pytest.raises(PrivateRPCError, match="PRIVATE_REQUEST_INVALID"):
        invoke(live, "drafts/preview", preview_input(live), "bob")
    with pytest.raises(PrivateRPCError, match="PRIVATE_FORBIDDEN"):
        invoke(live, "drafts/get", {"draftId": "draft-01"}, "legacy")


@native
def test_native_original_command_is_immutable_and_changed_payload_conflicts(live):
    args, _ = prepare(live, filled())
    first = invoke(live, "drafts/adopt", args)
    changed = copy.deepcopy(args)
    changed["fields"]["name"] = "Changed"
    with pytest.raises(PrivateRPCError, match="PRIVATE_CONFLICT"):
        invoke(live, "drafts/adopt", changed)
    next_args, p = prepare(live, filled("S02"), "draft-save-02")
    assert p["expectedRevision"] == 1 and p["current"] == first["draft"]
    second = invoke(live, "drafts/adopt", next_args)
    assert second["draft"]["revision"] == 2
    assert invoke(live, "drafts/request", {"requestId": args["requestId"]}) == first


def table_counts(live):
    return {
        table: live["owner"]
        .execute("SELECT count(*) AS n FROM astarter_private." + table)
        .fetchone()["n"]
        for table in ("draft_versions", "draft_heads", "draft_commands")
    }


@native
def test_native_two_sessions_have_one_atomic_cas_winner(live):
    args, _ = prepare(live, filled())
    barrier = Barrier(2)

    def save(who):
        barrier.wait(3)
        try:
            return invoke(live, "drafts/adopt", args | {"requestId": "save-" + who}, who)
        except PrivateRPCError as error:
            return error.code

    with ThreadPoolExecutor(max_workers=2) as workers:
        results = list(workers.map(save, ("alice", "alice-second")))
    assert sum(isinstance(r, dict) for r in results) == 1
    assert results.count("PRIVATE_CONFLICT") == 1
    assert table_counts(live) == {"draft_versions": 1, "draft_heads": 1, "draft_commands": 1}


@native
def test_native_same_request_parallel_replays_original_without_second_version(live):
    args, _ = prepare(live, filled())
    with ThreadPoolExecutor(max_workers=2) as workers:
        results = list(
            workers.map(
                lambda who: invoke(live, "drafts/adopt", args, who), ("alice", "alice-second")
            )
        )
    assert results[0] == results[1]
    assert table_counts(live)["draft_versions"] == 1


def workspace_save(live, state, request):
    return invoke(
        live,
        "workspace/save",
        {
            "requestId": request,
            "baseRevision": state["revision"],
            **{key: state[key] for key in ("preferences", "drafts", "selectedDraftId")},
        },
    )


@native
def test_native_workspace_change_invalidates_preview_without_overwrite(live):
    args, _ = prepare(live)
    state = invoke(live, "workspace/state")
    state["preferences"]["workbenchFilter"] = "tracked"
    original = workspace_save(live, state, "legacy-change-01")
    with pytest.raises(PrivateRPCError, match="PRIVATE_CONFLICT"):
        invoke(live, "drafts/adopt", args)
    assert table_counts(live) == {"draft_versions": 0, "draft_heads": 0, "draft_commands": 0}
    assert invoke(live, "workspace/state") == original["state"]


@native
def test_native_complete_version_owns_metadata_and_hiding_preserves_history(live):
    args, _ = prepare(live, filled())
    original = invoke(live, "drafts/adopt", args)
    state = invoke(live, "workspace/state")
    for key, value in (("name", "Old client rename"), ("strategyId", "S02")):
        changed = copy.deepcopy(state)
        changed["drafts"][0][key] = value
        with pytest.raises(PrivateRPCError, match="PRIVATE_CONFLICT"):
            workspace_save(live, changed, "legacy-edit-" + key)
    removed = state | {"drafts": [], "selectedDraftId": None}
    workspace_save(live, removed, "legacy-remove-01")
    assert invoke(live, "drafts/get", {"draftId": "draft-01"}) == original["draft"]
    restore, p = prepare(live, filled(), "draft-restore-01")
    assert not p["listed"] and p["expectedRevision"] == 1 and p["changedFields"] == []
    assert invoke(live, "drafts/adopt", restore)["draft"]["revision"] == 2
    assert len(invoke(live, "workspace/state")["drafts"]) == 1
    assert invoke(live, "drafts/request", {"requestId": args["requestId"]}) == original


@native
def test_native_rollback_after_workspace_write_leaves_no_partial_draft(live):
    args, _ = prepare(live, filled())
    before = invoke(live, "workspace/state")
    save = PrivateUIRepository._save_workspace

    def fail_after_save(*arguments):
        save(*arguments)
        raise PrivateRPCError("PRIVATE_UNAVAILABLE")

    with patch.object(PrivateUIRepository, "_save_workspace", side_effect=fail_after_save):
        with pytest.raises(PrivateRPCError, match="PRIVATE_UNAVAILABLE"):
            invoke(live, "drafts/adopt", args)
    assert invoke(live, "workspace/state") == before
    assert table_counts(live) == {"draft_versions": 0, "draft_heads": 0, "draft_commands": 0}


@native
def test_native_postcommit_unknown_and_later_expired_source_recover_original(live):
    args, _ = prepare(live, filled())
    commit = live["pool"]._commit

    def lost_ack(c):
        commit(c)
        raise psycopg.OperationalError("SYNTHETIC_POST_COMMIT_ACK_LOST")

    with patch.object(live["pool"], "_commit", lost_ack), pytest.raises(CommitUnknown):
        invoke(live, "drafts/adopt", args)
    original = invoke(live, "drafts/request", {"requestId": args["requestId"]})
    assert original["request"]["status"] == "applied"
    source_check = drafts.report_source

    def expired(row, **kwargs):
        # Advance only the freshness clock on synthetic data; session/lease stay real PG gates.
        return source_check(row, **(kwargs | {"now": row["result"]["validUntil"] + 1}))

    with patch.object(drafts, "report_source", side_effect=expired):
        assert invoke(live, "drafts/request", {"requestId": args["requestId"]}) == original
        assert invoke(live, "drafts/adopt", args) == original
        with pytest.raises(PrivateRPCError, match="PRIVATE_REQUEST_INVALID"):
            prepare(live, filled(), "draft-fresh-02")
    assert table_counts(live) == {"draft_versions": 1, "draft_heads": 1, "draft_commands": 1}


@native
@pytest.mark.parametrize("gate", ["session", "lease"])
def test_native_final_revocation_rolls_back_all_adopt_mutations(live, gate):
    args, _ = prepare(live)
    identify = PrivateUIRepository._identity
    calls = 0

    def revoke(self, c, token, permission):
        nonlocal calls
        calls += 1
        if calls == 3:
            if gate == "session":
                live["owner"].execute(
                    "UPDATE astarter_private.sessions SET revoked_at_ms="
                    "floor(extract(epoch FROM clock_timestamp())*1000) WHERE token_hash=%s",
                    (token,),
                )
            else:
                live["owner"].execute(
                    "UPDATE astarter_private.leases SET expires_at_ms="
                    "floor(extract(epoch FROM clock_timestamp())*1000)"
                )
        return identify(self, c, token, permission)

    with patch.object(PrivateUIRepository, "_identity", revoke), pytest.raises(PrivateRPCError):
        invoke(live, "drafts/adopt", args)
    assert calls == 3
    assert table_counts(live) == {"draft_versions": 0, "draft_heads": 0, "draft_commands": 0}
    assert (
        live["owner"]
        .execute("SELECT count(*) AS n FROM astarter_private.workspace_preferences")
        .fetchone()["n"]
        == 0
    )


@native
def test_native_cross_owner_rls_appendonly_and_exact_column_privileges(live):
    args, _ = prepare(live, filled())
    invoke(live, "drafts/adopt", args)
    with live["pool"].transaction(write=True, scope_id="untrusted-other-scope") as c:
        c.execute(
            "SELECT set_config('astarter_private.session_digest',%s,TRUE)",
            (live["users"]["bob"]["digest"],),
        )
        for table in ("draft_versions", "draft_heads", "draft_commands"):
            assert c.execute("SELECT * FROM astarter_private." + table).fetchall() == []
        assert (
            c.execute("UPDATE astarter_private.draft_heads SET revision=revision+1").rowcount == 0
        )
        for statement in (
            "UPDATE astarter_private.draft_versions SET content='{}'::jsonb WHERE FALSE",
            "DELETE FROM astarter_private.draft_versions WHERE FALSE",
            "UPDATE astarter_private.draft_commands SET fingerprint=repeat('a',64) WHERE FALSE",
            "UPDATE astarter_private.draft_heads SET subject_id='other' WHERE FALSE",
            "UPDATE astarter_private.global_budget SET spent_microusd=0 WHERE FALSE",
        ):
            with pytest.raises(psycopg.errors.InsufficientPrivilege), c.transaction():
                c.execute(statement)
        c.execute(
            "SELECT set_config('astarter_private.session_digest',%s,TRUE)",
            (live["users"]["alice"]["digest"],),
        )
        with pytest.raises(psycopg.Error, match="PRIVATE_DRAFT_HEAD_CONFLICT"), c.transaction():
            c.execute("UPDATE astarter_private.draft_heads SET revision=revision+2")


@native
def test_native_preview_hash_binds_user_parameters_source_and_both_cas_revisions(live):
    args, p = prepare(live, filled())
    assert prepare(live, filled())[1] == p
    for key, value in (
        ("proposalRevision", "0" * 64),
        ("expectedRevision", 1),
        ("workspaceRevision", 1),
        ("draftId", "another-draft"),
    ):
        with pytest.raises(PrivateRPCError, match="PRIVATE_CONFLICT"):
            invoke(live, "drafts/adopt", args | {key: value})
    changed = copy.deepcopy(args)
    changed["fields"]["amount"] = 21
    with pytest.raises(PrivateRPCError, match="PRIVATE_CONFLICT"):
        invoke(live, "drafts/adopt", changed)
    assert table_counts(live)["draft_versions"] == 0


@native
def test_native_migration_is_idempotent_retains_old_ui_receipts_and_issuer(live):
    upgrade_private_drafts(live["owner"], target=live["target"])
    assert (
        invoke(live, "workspace/request", {"requestId": "before-migration-01"})
        == (live["old_receipt"])
    )
    state = invoke(live, "workspace/state")
    state["preferences"]["watchedAssets"] = ["BTC"]
    original = workspace_save(live, state, "legacy-compatible-01")
    assert invoke(live, "workspace/request", {"requestId": "legacy-compatible-01"}) == original
    from tests.unit.control.postgres.test_private_ui_native import _issue

    user = _issue(live["issuer"], "3", uuid4().hex, 2)
    assert (
        live["research"].invoke(
            "drafts/get", scope(live["lease"]) | {"draftId": "draft-01"}, user["digest"]
        )
        is None
    )


@native
def test_native_failed_upgrade_rolls_back_catalog_and_populated_old_rows(legacy_live):
    old = legacy_live
    completed(old)
    owner, target = old["owner"], replace(old["target"], schema_version=3)
    requests = owner.execute("SELECT * FROM astarter_private.requests").fetchall()
    notices = owner.execute("SELECT * FROM astarter_private.notification_inbox").fetchall()
    catalog = base.m.private_catalog_digest(owner)

    def reject():
        raise RuntimeError("SYNTHETIC_BEFORE_COMMIT")

    with pytest.raises(RuntimeError, match="SYNTHETIC_BEFORE_COMMIT"):
        upgrade_private_drafts(owner, target=target, before_commit=reject)
    assert base.m.private_catalog_digest(owner) == catalog
    assert owner.execute("SELECT schema_version FROM astarter_private.metadata").fetchone() == {
        "schema_version": 2
    }
    assert owner.execute("SELECT * FROM astarter_private.requests").fetchall() == requests
    assert owner.execute("SELECT * FROM astarter_private.notification_inbox").fetchall() == notices
    assert (
        old["research"].invoke(
            "workspace/state", scope(old["lease"]), old["users"]["alice"]["digest"]
        )["revision"]
        == 0
    )


@native
def test_native_old_profile_cannot_treat_new_catalog_as_old_schema(live):
    old_pool = pool_for(replace(live["target"], schema_version=2), "runtime")
    try:
        with pytest.raises(AccessRejected, match="PRIVATE_COLUMN_PRIVILEGE"):
            old_pool.open()
    finally:
        old_pool.close()


@native
@pytest.mark.parametrize("abort", [False, True])
def test_native_filled_v2_history_and_budget_survive_upgrade_or_rollback(legacy_live, abort):
    old = legacy_live
    owner, repo, user = old["owner"], old["research"], old["users"]["alice"]
    completed(old)
    ids = ["request-001"]
    for state in ("failed", "unknown", "pending"):
        request = "old-" + state + "-01"
        acquired = repo.invoke(
            "research/claim", claim_payload(repo, user, old["lease"], request), user["digest"]
        )
        if state != "pending":
            payload = finish_payload(user, old["lease"], acquired["claimToken"], state)
            repo.invoke("research/finish", payload | {"requestId": request}, user["digest"])
        ids.append(request)
    with old["pg"].connect(user=old["target"].cost, dbname=old["target"].database) as cost:
        cost.execute("SET statement_timeout='4s'")
        assert cost.execute(
            "SELECT astarter_private.settle_cost(%s,%s,%s,%s,%s,%s) AS settled",
            ("synthetic-old-receipt", user["subject"], user["subject"], "request-001", 300, 150),
        ).fetchone() == {"settled": True}
    workspace = invoke(old, "workspace/state")
    workspace["preferences"]["watchedAssets"] = ["BTC"]
    receipt = workspace_save(old, workspace, "old-workspace-01")
    notices = invoke(old, "notifications/state", {"cursor": None, "limit": 20})
    read = invoke(
        old,
        "notifications/command",
        {
            "requestId": "old-notice-01",
            "baseRevision": notices["revision"],
            "action": "mark-read",
            "payload": {"ids": [notices["inbox"][0]["id"]]},
        },
    )
    tables = (
        "challenges",
        "sessions",
        "leases",
        "global_budget",
        "policies",
        "requests",
        "cost_events",
        "notification_preferences",
        "notification_inbox",
        "workspace_preferences",
        "ui_commands",
    )

    def snapshot():
        return {
            name: owner.execute(
                "SELECT * FROM astarter_private." + name + " AS t ORDER BY to_jsonb(t)::text"
            ).fetchall()
            for name in tables
        }

    args = scope(old["lease"]) | dict(
        tenantId=user["subject"], subjectId=user["subject"], scopeId=user["subject"]
    )
    records = {r: repo.invoke("research/get", args | {"requestId": r}, user["digest"]) for r in ids}
    before = snapshot()
    assert before["global_budget"][0]["held_microusd"] > 0
    assert before["global_budget"][0]["spent_microusd"] == 300
    assert before["cost_events"] and before["workspace_preferences"]
    old["pool"].close()
    old["issuer"]._pool.close()
    target = replace(old["target"], schema_version=3)
    if abort:

        def reject():
            raise RuntimeError("SYNTHETIC_BEFORE_COMMIT")

        with pytest.raises(RuntimeError, match="SYNTHETIC_BEFORE_COMMIT"):
            upgrade_private_drafts(owner, target=target, before_commit=reject)
        target = old["target"]
    else:
        upgrade_private_drafts(owner, target=target)
        upgrade_private_drafts(owner, target=target)
    assert snapshot() == before
    assert owner.execute("SELECT schema_version FROM astarter_private.metadata").fetchone() == {
        "schema_version": 2 if abort else 3
    }
    pool = pool_for(target, "runtime")
    try:
        pool.open()
        restored = old | {"research": PrivateRuntimeRepository(pool, lease=old["lease"])}
        for request in ids:
            assert (
                restored["research"].invoke(
                    "research/get", args | {"requestId": request}, user["digest"]
                )
                == records[request]
            )
        assert invoke(restored, "workspace/request", {"requestId": "old-workspace-01"}) == receipt
        assert invoke(restored, "notifications/request", {"requestId": "old-notice-01"}) == read
        assert (
            invoke(restored, "notifications/state", {"cursor": None, "limit": 20}) == read["state"]
        )
        assert snapshot() == before
    finally:
        pool.close()


@native
def test_native_existing_rpc_dispatches_drafts_without_new_permissions(live):
    app = create_private_research_app(
        runtime=live["research"],
        issuer=live["issuer"],
        runtime_secret="r" * 48,
        issuer_secret="i" * 48,
    )
    with TestClient(app) as client:
        headers = {
            "Authorization": "Bearer " + "r" * 48,
            "X-Astarter-Private-Session-Digest": live["users"]["alice"]["digest"],
        }
        path = "/internal/private/v1/drafts/"
        body = scope(live["lease"]) | preview_input(live, filled())
        response = client.post(path + "preview", json=body, headers=headers)
        assert response.status_code == 200 and response.headers["cache-control"] == "no-store"
        p = response.json()["result"]
        adopt = body | {
            "requestId": "rpc-adopt-01",
            **{k: p[k] for k in ("expectedRevision", "workspaceRevision", "proposalRevision")},
        }
        result = client.post(path + "adopt", json=adopt, headers=headers)
        assert result.status_code == 200
        recovered = client.post(
            path + "request",
            headers=headers,
            json=scope(live["lease"]) | {"requestId": "rpc-adopt-01"},
        )
        assert recovered.json() == result.json()
        denied = client.post(
            path + "get",
            json=scope(live["lease"]) | {"draftId": "draft-01"},
            headers={"Authorization": "Bearer " + "r" * 48},
        )
        assert denied.status_code == 401
        assert client.post(path + "start", json=adopt, headers=headers).status_code == 404


@native
def test_native_workspace_limit_rejects_without_partial_version(live):
    state = invoke(live, "workspace/state")
    state["drafts"] = [
        {"id": "old-" + str(i), "strategyId": "S01", "name": "Synthetic"} for i in range(50)
    ]
    workspace_save(live, state, "full-workspace-01")
    args, _ = prepare(live, filled())
    with pytest.raises(PrivateRPCError, match="PRIVATE_REQUEST_INVALID"):
        invoke(live, "drafts/adopt", args)
    assert table_counts(live)["draft_versions"] == 0
    assert len(invoke(live, "workspace/state")["drafts"]) == 50


@native
@pytest.mark.parametrize("method", ["drafts/preview", "drafts/adopt"])
@pytest.mark.parametrize("reference", ["sk-" + "x" * 24, "0x" + "a" * 64])
def test_native_credential_shaped_connection_is_rejected_before_checkout(live, method, reference):
    args, _ = prepare(live, filled())
    if method == "drafts/preview":
        args = preview_input(live, filled())
    args["fields"]["executionRoute"]["connectionId"] = reference
    with patch.object(
        live["pool"], "transaction", side_effect=AssertionError("CHECKOUT_FORBIDDEN")
    ):
        with pytest.raises(PrivateRPCError, match="PRIVATE_REQUEST_INVALID"):
            invoke(live, method, args)
    assert table_counts(live) == {"draft_versions": 0, "draft_heads": 0, "draft_commands": 0}
