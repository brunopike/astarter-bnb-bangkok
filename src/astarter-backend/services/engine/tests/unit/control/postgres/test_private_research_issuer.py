"""Only a new owned local PG17 fixture; no DSN discovery or real signature/model calls."""

import time
from concurrent.futures import ThreadPoolExecutor
from hashlib import sha256
from threading import Barrier

import pytest
from psycopg.conninfo import make_conninfo

from stark_trading_os.control.postgres import private_research_issuer as issuer_module
from stark_trading_os.control.postgres.access import RepositoryAccessContract
from stark_trading_os.control.postgres.pool import CommitUnknown, PgRepositoryPool, PoolSettings
from stark_trading_os.control.postgres.private_research_issuer import PrivateIssuerRepository
from tests.unit.control.postgres.test_private_research_migration import (
    db as db,
)
from tests.unit.control.postgres.test_private_research_migration import (
    native,
)
from tests.unit.control.postgres.test_private_research_migration import (
    pg as pg,
)

ORIGIN = "https://astarter.imstark.site"


def hashed(value: str) -> str:
    return sha256(value.encode()).hexdigest()


@pytest.fixture
def issuer(db):
    _, _, target = db
    pool = PgRepositoryPool(
        make_conninfo(
            host=target.host, port=target.port, dbname=target.database, user=target.issuer
        ),
        settings=PoolSettings(max_size=4),
        access_contract=RepositoryAccessContract.PRIVATE_RESEARCH_V1,
        private_target=target,
        private_role="issuer",
    )
    try:
        pool.open()
        yield PrivateIssuerRepository(pool), pool
    finally:
        pool.close()


def challenge(repo, suffix="a"):
    now = time.time_ns() // 1_000_000 - 5
    record = {
        "challengeHash": hashed(suffix),
        "nonce": hashed(suffix + "nonce"),
        "origin": ORIGIN,
        "issuedAt": now,
        "expires": now + 300000,
        "address": None,
        "chain": None,
        "message": None,
    }
    saved = repo.invoke("auth/challenge/issue", record, None)
    assert saved is not None
    assert {k: v for k, v in saved.items() if k not in {"issuedAt", "expires"}} == {
        k: v for k, v in record.items() if k not in {"issuedAt", "expires"}
    }
    assert now <= saved["issuedAt"] <= time.time_ns() // 1_000_000
    assert saved["expires"] == saved["issuedAt"] + 300000
    return saved


def binding(record, digit="1"):
    return {
        "challengeHash": record["challengeHash"],
        "nonce": record["nonce"],
        "address": "0x" + digit * 40,
        "chain": 56,
        "message": "Owned synthetic SIWE fixture",
        "now": time.time_ns() // 1_000_000,
    }


def consume(repo, record, digit="1"):
    args = binding(record, digit)
    prepared = repo.invoke("auth/challenge/prepare", args, None)
    assert prepared["address"] == args["address"]
    claim = repo.invoke("auth/challenge/consume", args, None)
    assert claim and 32 <= len(claim["claimToken"]) <= 128
    return args, claim


def session_args(args, claim, suffix="one", previous=None):
    now = time.time_ns() // 1_000_000
    return {
        "tokenHash": hashed(suffix),
        "previousTokenHash": previous,
        "challengeHash": args["challengeHash"],
        "claimToken": claim["claimToken"],
        "address": args["address"],
        "chain": 56,
        "origin": ORIGIN,
        "issuedAt": now,
        "expires": now + 604800000,
        "permissions": ["research:analyze"],
    }


@native
def test_consumed_nonce_cannot_mint_two_sessions_and_revoke_cancels_existing(issuer):
    repo, _ = issuer
    record = challenge(repo)
    args, claim = consume(repo, record)
    assert repo.invoke("auth/challenge/consume", args, None) is None
    data = session_args(args, claim)
    session = repo.invoke("auth/session/issue", data, None)
    assert session["subjectId"] == session["scopeId"] == "wallet:56:" + args["address"]
    key = {"tokenHash": data["tokenHash"], "now": 0}
    assert repo.invoke("auth/session/resolve", key, None) == session
    assert repo.invoke("auth/session/issue", session_args(args, claim, "two"), None) is None
    revoke = {"challengeHash": record["challengeHash"], "now": 0}
    assert repo.invoke("auth/challenge/revoke", revoke, None) is True
    assert repo.invoke("auth/challenge/revoke", revoke, None) is True
    assert repo.invoke("auth/session/resolve", key, None) is None
    assert repo.invoke("auth/session/issue", session_args(args, claim, "three"), None) is None


@native
def test_first_preparation_cannot_be_rebound_and_two_consumers_have_one_winner(issuer):
    repo, _ = issuer
    record = challenge(repo)
    args = binding(record)
    assert repo.invoke("auth/challenge/prepare", args, None)["address"] == args["address"]
    assert repo.invoke("auth/challenge/prepare", binding(record, "2"), None) is None
    start = Barrier(2)

    def take():
        start.wait(3)
        return repo.invoke("auth/challenge/consume", args, None)

    with ThreadPoolExecutor(max_workers=2) as workers:
        results = list(workers.map(lambda _: take(), range(2)))
    assert sum(result is not None for result in results) == 1


@native
def test_account_switch_revokes_old_cookie_and_maps_new_identity_in_server(issuer):
    repo, _ = issuer
    old_args, old_claim = consume(repo, challenge(repo, "old"))
    old = session_args(old_args, old_claim, "old-token")
    old_session = repo.invoke("auth/session/issue", old, None)
    new_args, new_claim = consume(repo, challenge(repo, "new"), "2")
    new = session_args(new_args, new_claim, "new-token", old["tokenHash"])
    new_session = repo.invoke("auth/session/issue", new, None)
    assert new_session["scopeId"] != old_session["scopeId"]
    assert (
        repo.invoke("auth/session/resolve", {"tokenHash": old["tokenHash"], "now": 0}, None) is None
    )
    with pytest.raises(ValueError):
        repo.invoke("auth/session/issue", new | {"subjectId": "forged"}, None)


@native
def test_unknown_commit_retains_session_and_does_not_reuse_consumed_claim(issuer, monkeypatch):
    repo, pool = issuer
    args, claim = consume(repo, challenge(repo))
    data = session_args(args, claim)
    original = pool._commit

    def lose_ack(connection):
        original(connection)
        raise OSError("synthetic lost acknowledgment")

    monkeypatch.setattr(pool, "_commit", lose_ack)
    with pytest.raises(CommitUnknown):
        repo.invoke("auth/session/issue", data, None)
    monkeypatch.setattr(pool, "_commit", original)
    assert repo.invoke("auth/session/resolve", {"tokenHash": data["tokenHash"], "now": 0}, None)
    assert repo.invoke("auth/session/issue", session_args(args, claim, "again"), None) is None


@native
def test_client_time_cannot_revive_expired_challenge(db, issuer):
    _, owner, _ = db
    repo, _ = issuer
    now = time.time_ns() // 1_000_000
    owner.execute(
        "INSERT INTO astarter_private.challenges(challenge_hash,nonce,origin,"
        "issued_at_ms,expires_at_ms) VALUES(%s,%s,%s,%s,%s)",
        (hashed("expired"), hashed("nonce"), ORIGIN, now - 600000, now - 300000),
    )
    result = repo.invoke("auth/challenge/get", {"challengeHash": hashed("expired"), "now": 1}, None)
    assert result is None


@native
def test_time_is_rechecked_after_waiting_for_challenge_lock(db, issuer):
    pg, owner, target = db
    repo, pool = issuer
    now = int(
        owner.execute(
            "SELECT floor(extract(epoch FROM clock_timestamp())*1000) AS now_ms"
        ).fetchone()["now_ms"]
    )
    expires = now + 800
    key, nonce, address = hashed("blocked-expiry"), hashed("public-nonce"), "0x" + "3" * 40
    owner.execute(
        "INSERT INTO astarter_private.challenges(challenge_hash,nonce,origin,"
        "issued_at_ms,expires_at_ms) VALUES(%s,%s,%s,%s,%s)",
        (key, nonce, ORIGIN, expires - 300000, expires),
    )
    owner.execute(
        "UPDATE astarter_private.challenges SET address=%s,chain_id=56,"
        "message='bounded SIWE',prepared_at_ms=%s WHERE challenge_hash=%s",
        (address, now, key),
    )
    with pool.transaction() as connection:
        pid = connection.info.backend_pid
    args = {
        "challengeHash": key,
        "nonce": nonce,
        "address": address,
        "chain": 56,
        "message": "bounded SIWE",
        "now": 0,
    }
    with ThreadPoolExecutor(max_workers=1) as workers:
        with owner.transaction():
            owner.execute(
                "SELECT 1 FROM astarter_private.challenges WHERE challenge_hash=%s FOR UPDATE",
                (key,),
            )
            future = workers.submit(repo.invoke, "auth/challenge/consume", args, None)
            with pg.connect() as admin:
                deadline = time.monotonic() + 0.5
                while time.monotonic() < deadline:
                    wait = admin.execute(
                        "SELECT wait_event_type='Lock' AS waiting "
                        "FROM pg_stat_activity WHERE pid=%s AND datname=%s",
                        (pid, target.database),
                    ).fetchone()
                    if wait == {"waiting": True}:
                        break
                    time.sleep(0.01)
                else:
                    raise AssertionError("OWNED_LOCK_WAIT_NOT_OBSERVED")
            assert not future.done()
            time.sleep(max(0, (expires - time.time_ns() // 1_000_000) / 1000) + 0.02)
        assert future.result(timeout=3) is None


@native
@pytest.mark.parametrize("client_skew", [-250, 250])
def test_challenge_uses_database_clock_instead_of_echoing_client_time(
    db, issuer, monkeypatch, client_skew
):
    _, owner, _ = db
    repo, _ = issuer
    server_now = int(
        owner.execute(
            "SELECT floor(extract(epoch FROM clock_timestamp())*1000) AS now_ms"
        ).fetchone()["now_ms"]
    )
    monkeypatch.setattr(issuer_module, "_clock", lambda _: server_now)
    issued = server_now + client_skew
    data = {
        "challengeHash": hashed("clock-challenge"),
        "nonce": hashed("clock-nonce"),
        "origin": ORIGIN,
        "issuedAt": issued,
        "expires": issued + 300000,
        "address": None,
        "chain": None,
        "message": None,
    }
    saved = repo.invoke("auth/challenge/issue", data, None)
    assert saved is not None
    assert (saved["issuedAt"], saved["expires"]) == (server_now, server_now + 300000)
    row = owner.execute(
        "SELECT issued_at_ms,expires_at_ms FROM astarter_private.challenges "
        "WHERE challenge_hash=%s",
        (data["challengeHash"],),
    ).fetchone()
    assert (int(row["issued_at_ms"]), int(row["expires_at_ms"])) == (
        server_now,
        server_now + 300000,
    )


@native
def test_session_client_time_before_consumption_does_not_backdate_database_session(
    db, issuer, monkeypatch
):
    _, owner, _ = db
    repo, _ = issuer
    args, claim = consume(repo, challenge(repo, "clock-session"))
    consumed = int(
        owner.execute(
            "SELECT consumed_at_ms FROM astarter_private.challenges WHERE challenge_hash=%s",
            (args["challengeHash"],),
        ).fetchone()["consumed_at_ms"]
    )
    server_now = consumed + 10
    monkeypatch.setattr(issuer_module, "_clock", lambda _: server_now)
    data = session_args(args, claim, "clock-token")
    data.update(issuedAt=consumed - 125, expires=consumed - 125 + 604800000)
    saved = repo.invoke("auth/session/issue", data, None)
    assert saved is not None
    assert (saved["issuedAt"], saved["expires"]) == (server_now, server_now + 604800000)
    row = owner.execute(
        "SELECT not_before_ms,expires_at_ms FROM astarter_private.sessions WHERE token_digest=%s",
        (data["tokenHash"],),
    ).fetchone()
    assert int(row["not_before_ms"]) >= consumed
    assert int(row["expires_at_ms"]) - int(row["not_before_ms"]) == 604800000


@native
@pytest.mark.parametrize(
    "client_skew,accepted", [(-5001, False), (-5000, True), (5000, True), (5001, False)]
)
def test_challenge_client_clock_hint_keeps_exact_five_second_bound(
    db, issuer, monkeypatch, client_skew, accepted
):
    _, owner, _ = db
    repo, _ = issuer
    server_now = int(
        owner.execute(
            "SELECT floor(extract(epoch FROM clock_timestamp())*1000) AS now_ms"
        ).fetchone()["now_ms"]
    )
    monkeypatch.setattr(issuer_module, "_clock", lambda _: server_now)
    issued = server_now + client_skew
    data = {
        "challengeHash": hashed("clock-bound"),
        "nonce": hashed("clock-bound-nonce"),
        "origin": ORIGIN,
        "issuedAt": issued,
        "expires": issued + 300000,
        "address": None,
        "chain": None,
        "message": None,
    }
    saved = repo.invoke("auth/challenge/issue", data, None)
    assert (saved is not None) is accepted
    assert owner.execute("SELECT count(*) AS n FROM astarter_private.challenges").fetchone()[
        "n"
    ] == int(accepted)


@native
def test_database_clock_regression_cannot_issue_session(db, issuer, monkeypatch):
    _, owner, _ = db
    repo, _ = issuer
    args, claim = consume(repo, challenge(repo, "clock-regression"))
    consumed = int(
        owner.execute(
            "SELECT consumed_at_ms FROM astarter_private.challenges WHERE challenge_hash=%s",
            (args["challengeHash"],),
        ).fetchone()["consumed_at_ms"]
    )
    monkeypatch.setattr(issuer_module, "_clock", lambda _: consumed - 1)
    data = session_args(args, claim, "clock-regression-token")
    data.update(issuedAt=consumed - 2, expires=consumed - 2 + 604800000)
    assert repo.invoke("auth/session/issue", data, None) is None
    assert owner.execute("SELECT count(*) AS n FROM astarter_private.sessions").fetchone()["n"] == 0


@native
@pytest.mark.parametrize(
    "client_skew,accepted", [(-5001, False), (-5000, True), (5000, True), (5001, False)]
)
def test_session_client_clock_hint_keeps_exact_five_second_bound(
    db, issuer, monkeypatch, client_skew, accepted
):
    _, owner, _ = db
    repo, _ = issuer
    args, claim = consume(repo, challenge(repo, "session-clock-bound"))
    server_now = int(
        owner.execute(
            "SELECT floor(extract(epoch FROM clock_timestamp())*1000) AS now_ms"
        ).fetchone()["now_ms"]
    )
    monkeypatch.setattr(issuer_module, "_clock", lambda _: server_now)
    data = session_args(args, claim, "session-clock-bound-token")
    data.update(issuedAt=server_now + client_skew, expires=server_now + client_skew + 604800000)
    saved = repo.invoke("auth/session/issue", data, None)
    assert (saved is not None) is accepted
    if accepted:
        assert (saved["issuedAt"], saved["expires"]) == (server_now, server_now + 604800000)
    assert owner.execute("SELECT count(*) AS n FROM astarter_private.sessions").fetchone()[
        "n"
    ] == int(accepted)
