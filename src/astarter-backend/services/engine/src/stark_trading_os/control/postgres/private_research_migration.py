"""Explicit dedicated PRIVATE empty-database migration; no connection/discovery on import."""

import re
from dataclasses import dataclass
from hashlib import sha256
from importlib.resources import files
from typing import Any

from psycopg import Connection
from psycopg.pq import TransactionStatus

from .access import AccessRejected
from .private_research_contracts import CONTRACT
from .research_access import research_catalog_rows_sql
from .synthetic_migration import TargetProfile, sql_statements

CAPABILITIES = {
    "runtime": "astarter_private_runtime",
    "issuer": "astarter_private_issuer",
    "cost": "astarter_private_cost",
}
RESOURCE_SHA256 = "acff7f2db95d2aedf3151e3ec64b2ae76e6dac9fea31e7dbc7b15c34c686610d"
LOCAL_EMPTY_PIN = "7ef54546eb99777c47c19d269884e526c5e41fa9c0299f7a79f6aa3b3c838ab6"
LOCAL_CATALOG_PIN = "e340cdbd1fc2e88ac1654cdd5815c5f246247246d355f5605184ce6d1bf2137d"
# Independent Neon Oracle receipt 857a6feb, 2026-11-16; no application-target learning.
NEON_EMPTY_PIN = "7ef54546eb99777c47c19d269884e526c5e41fa9c0299f7a79f6aa3b3c838ab6"
NEON_CATALOG_PIN = "e340cdbd1fc2e88ac1654cdd5815c5f246247246d355f5605184ce6d1bf2137d"


@dataclass(frozen=True)
class PrivateTarget:
    profile: TargetProfile
    host: str
    port: int
    database: str
    owner: str
    runtime: str
    issuer: str
    cost: str
    target_id: str
    schema_version: int = 1

    def __post_init__(self) -> None:
        names = (self.database, self.owner, self.runtime, self.issuer, self.cost)
        if (
            type(self.profile) is not TargetProfile
            or type(self.schema_version) is not int or self.schema_version not in (1, 2, 3)
            or type(self.port) is not int
            or not 1 <= self.port <= 65535
            or any(
                type(n) is not str or not re.fullmatch(r"[a-z_][a-z0-9_]{0,62}", n) for n in names
            )
            or len(set(names[1:])) != 4
            or set(names[1:]) & set(CAPABILITIES.values())
            or type(self.target_id) is not str
            or not re.fullmatch(r"[A-Za-z0-9:_-]{1,128}", self.target_id)
            or type(self.host) is not str
            or not re.fullmatch(
                r"/[^,\x00-\x1f]+"
                if self.profile is TargetProfile.LOCAL_PG17
                else r"ep-[a-z0-9-]+\.[a-z0-9.-]+\.neon\.tech",
                self.host,
            )
        ):
            raise AccessRejected("PRIVATE_TARGET_INVALID")


def private_profile_pins(profile: TargetProfile, schema_version: int = 1) -> tuple[str, str]:
    """Return only the explicit independent empty/full baseline for the selected profile."""
    if type(profile) is not TargetProfile:
        raise AccessRejected("PRIVATE_PROFILE_INVALID")
    if type(schema_version) is not int or schema_version not in (1, 2, 3):
        raise AccessRejected("PRIVATE_PROFILE_INVALID")
    if schema_version == 3:
        from .private_draft_migration import draft_profile_pin
        return private_profile_pins(profile)[0], draft_profile_pin(profile)
    if schema_version == 2:
        from .private_ui_migration import ui_profile_pin
        return private_profile_pins(profile)[0], ui_profile_pin(profile)
    if profile is TargetProfile.LOCAL_PG17:
        pins = LOCAL_EMPTY_PIN, LOCAL_CATALOG_PIN
    elif profile is TargetProfile.NEON_PG17_V1:
        pins = NEON_EMPTY_PIN, NEON_CATALOG_PIN
    else:
        raise AccessRejected("PRIVATE_PROFILE_UNVERIFIED")
    if not all(re.fullmatch(r"[0-9a-f]{64}", p) for p in pins):
        raise AccessRejected("PRIVATE_PROFILE_UNVERIFIED")
    return pins


def private_resources() -> tuple[str, str, str]:
    package = files(__package__)
    schema = package.joinpath("private_research_schema_v1.sql").read_text(encoding="utf-8")
    access = package.joinpath("private_research_access_v1.sql").read_text(encoding="utf-8")
    mutations = package.joinpath("private_research_mutations_v1.sql").read_text(encoding="utf-8")
    payload = schema + "\n--PRIVATE-ACCESS--\n" + access + "\n--PRIVATE-MUTATIONS--\n" + mutations
    if sha256(payload.encode()).hexdigest() != RESOURCE_SHA256:
        raise AccessRejected("PRIVATE_RESOURCE_MISMATCH")
    return schema, access, mutations


def private_catalog_digest(connection: Connection[Any]) -> str:
    # Reuse the sealed inventory of every namespace/object/domain/ACL, including extras.
    row = connection.execute(
        "SELECT encode(sha256(convert_to(coalesce(string_agg(v,E'\\n' "
        "ORDER BY v COLLATE \"C\"),''),"
        "'UTF8')),'hex') AS digest FROM (" + research_catalog_rows_sql() + " UNION ALL "
        "SELECT json_build_array('private_policy_roles',c.oid::regclass::text,p.polname,"
        "ARRAY(SELECT r.rolname FROM pg_roles r WHERE "
        "r.oid=ANY(p.polroles) ORDER BY r.rolname))::text "
        "FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid) private_catalog"
    ).fetchone()
    if row is None:
        raise AccessRejected("PRIVATE_CATALOG_EMPTY")
    return str(row["digest"] if isinstance(row, dict) else row[0])


def check_connection(connection: Connection[Any], target: PrivateTarget, user: str) -> None:
    if type(target) is not PrivateTarget:
        raise AccessRejected("PRIVATE_TARGET_INVALID")
    private_profile_pins(target.profile, target.schema_version)
    if (
        not isinstance(connection, Connection)
        or connection.closed
        or (target.profile is TargetProfile.LOCAL_PG17 and connection.info.hostaddr != "")
        or (
            connection.info.host,
            connection.info.port,
            connection.info.dbname,
            connection.info.user,
        )
        != (target.host, target.port, target.database, user)
    ):
        raise AccessRejected("PRIVATE_CONNECTION_REJECTED")
    if target.profile is TargetProfile.NEON_PG17_V1:
        params = connection.info.get_parameters()
        if (
            not connection.pgconn.ssl_in_use
            or params.get("sslmode") != "verify-full"
            or params.get("channel_binding") != "require"
            or params.get("sslrootcert") != "system"
        ):
            raise AccessRejected("PRIVATE_CONNECTION_REJECTED")


def expected_metadata(target: PrivateTarget) -> dict[str, Any]:
    resource = RESOURCE_SHA256
    if target.schema_version == 2:
        from .private_ui_migration import ui_resource_hash
        resource = ui_resource_hash()
    elif target.schema_version == 3:
        from .private_draft_migration import draft_resource_hash
        resource = draft_resource_hash()
    return dict(
        singleton=True,
        contract=CONTRACT,
        schema_version=target.schema_version,
        resource_sha256=resource,
        profile=target.profile.value,
        target_id=target.target_id,
        database_name=target.database,
        owner_role=target.owner,
        runtime_role=target.runtime,
        issuer_role=target.issuer,
        cost_role=target.cost,
    )


def check_metadata(connection: Connection[Any], target: PrivateTarget) -> None:
    wrong_owner = connection.execute(
        "SELECT 1 FROM (SELECT n.nspowner AS owner FROM pg_namespace n "
        "WHERE n.nspname='astarter_private' UNION ALL "
        "SELECT c.relowner FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace "
        "WHERE n.nspname='astarter_private' UNION ALL "
        "SELECT p.proowner FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace "
        "WHERE n.nspname='astarter_private' UNION ALL "
        "SELECT t.typowner FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace "
        "WHERE n.nspname='astarter_private') objects "
        "WHERE owner<>%s::regrole LIMIT 1",
        (target.owner,),
    ).fetchone()
    if wrong_owner:
        raise AccessRejected("PRIVATE_OBJECT_OWNER")
    rows = connection.execute("SELECT * FROM astarter_private.metadata").fetchall()
    if rows != [expected_metadata(target)]:
        raise AccessRejected("PRIVATE_METADATA_MISMATCH")


def check_owner_identity(connection: Connection[Any], target: PrivateTarget) -> None:
    """The same owner and capability gate precedes either schema installation or upgrade."""
    row = connection.execute(
        "SELECT current_database() AS db,current_user AS role,session_user AS login,"
        "pg_get_userbyid(d.datdba) AS owner,"
        "current_setting('server_version_num')::int/10000 AS major,"
        "r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR "
        "r.rolreplication OR r.rolbypassrls "
        "OR NOT r.rolcanlogin OR r.rolconfig IS NOT NULL OR EXISTS "
        "(SELECT 1 FROM pg_auth_members m WHERE m.member=r.oid) AS unsafe "
        "FROM pg_database d,pg_roles r WHERE d.datname=current_database() "
        "AND r.rolname=current_user"
    ).fetchone()
    if row != dict(
        db=target.database,
        role=target.owner,
        login=target.owner,
        owner=target.owner,
        major=17,
        unsafe=False,
    ):
        raise AccessRejected("PRIVATE_OWNER_IDENTITY")
    caps = connection.execute(
        "SELECT rolname,rolcanlogin OR rolsuper OR rolcreatedb OR "
        "rolcreaterole OR rolreplication "
        "OR rolbypassrls OR rolconfig IS NOT NULL OR EXISTS(SELECT 1 FROM pg_auth_members m "
        "WHERE m.member=r.oid) AS unsafe FROM pg_roles r WHERE rolname=ANY(%s)",
        (list(CAPABILITIES.values()),),
    ).fetchall()
    if {r["rolname"] for r in caps} != set(CAPABILITIES.values()) or any(
        r["unsafe"] for r in caps
    ):
        raise AccessRejected("PRIVATE_CAPABILITY_REJECTED")


def install_private(connection: Connection[Any], *, target: PrivateTarget) -> None:
    """Owner-only single transaction; replay verifies, never alters a nonempty target."""
    if type(target) is not PrivateTarget or target.schema_version != 1:
        raise AccessRejected("PRIVATE_INSTALL_VERSION")
    check_connection(connection, target, target.owner)
    empty_pin, full_pin = private_profile_pins(target.profile)
    resources = private_resources()
    if not connection.autocommit or connection.pgconn.transaction_status != TransactionStatus.IDLE:
        raise AccessRejected("PRIVATE_OWNER_TRANSACTION")
    with connection.transaction():
        connection.execute("SET LOCAL search_path=pg_catalog")
        connection.execute("SET LOCAL statement_timeout='6s'")
        connection.execute("SET LOCAL lock_timeout='2s'")
        connection.execute("SELECT pg_advisory_xact_lock(671928041)")
        check_owner_identity(connection, target)
        digest = private_catalog_digest(connection)
        if digest == full_pin:
            check_metadata(connection, target)
            return
        if digest != empty_pin:
            raise AccessRejected("PRIVATE_EMPTY_CATALOG_REJECTED")
        for resource in resources:
            for statement in sql_statements(resource):
                connection.execute(statement)
        metadata = expected_metadata(target)
        connection.execute(
            "INSERT INTO astarter_private.metadata VALUES("
            + ",".join(["%s"] * len(metadata))
            + ")",
            tuple(metadata.values()),
        )
        if private_catalog_digest(connection) != full_pin:
            raise AccessRejected("PRIVATE_POST_CATALOG_REJECTED")
        check_metadata(connection, target)
