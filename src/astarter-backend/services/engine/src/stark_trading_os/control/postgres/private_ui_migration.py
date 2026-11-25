"""Explicit forward-only UI migration over an independently sealed PRIVATE catalog."""

from collections.abc import Callable
from dataclasses import replace
from hashlib import sha256
from importlib.resources import files
from typing import Any

from psycopg import Connection
from psycopg.pq import TransactionStatus

from . import private_research_migration as base
from .access import AccessRejected
from .synthetic_migration import TargetProfile, sql_statements

# Filled only from separate owned golden fixtures, never learned from an application target.
LOCAL_UI_PIN: str | None = "d5242c0c184e888c7b8e23c305036e3c3c679af814ffaca430fd04b6f7fbcd19"
# Independent NEON Oracle result dff11702, reviewed in both lanes, 2026-11-16.
NEON_UI_PIN: str | None = "d5242c0c184e888c7b8e23c305036e3c3c679af814ffaca430fd04b6f7fbcd19"
# Exact nine-grant local reconstruction of the observed Neon catalog, not a new oracle.
NEON_UI_PLATFORM_PIN: str | None = (
    "6fd8ee3d17863eeeb467afcf15296973178f1da8352d5e9766210716d336f95c"
)
UI_RESOURCE_SHA256: str | None = "91308b82c7a42f00484694959b44bb94d075f75b5ee4dbe7f509595a4f45cec7"


def ui_resource_hash() -> str:
    if UI_RESOURCE_SHA256 is None:
        raise AccessRejected("PRIVATE_UI_RESOURCE_UNVERIFIED")
    schema, access, mutations = base.private_resources()
    legacy = schema + "\n--PRIVATE-ACCESS--\n" + access + "\n--PRIVATE-MUTATIONS--\n" + mutations
    addon = files(__package__).joinpath("private_ui_schema_v1.sql").read_text(encoding="utf-8")
    actual = sha256((legacy + "\n--PRIVATE-UI--\n" + addon).encode()).hexdigest()
    if actual != UI_RESOURCE_SHA256:
        raise AccessRejected("PRIVATE_UI_RESOURCE_MISMATCH")
    return actual


def ui_profile_pin(profile: TargetProfile) -> str:
    pin = LOCAL_UI_PIN if profile is TargetProfile.LOCAL_PG17 else (
        NEON_UI_PIN if profile is TargetProfile.NEON_PG17_V1 else None
    )
    if pin is None:
        raise AccessRejected("PRIVATE_UI_PROFILE_UNVERIFIED")
    ui_resource_hash()
    return pin


def ui_catalog_matches(profile: TargetProfile, digest: str) -> bool:
    return digest == ui_profile_pin(profile) or (
        profile is TargetProfile.NEON_PG17_V1
        and NEON_UI_PLATFORM_PIN is not None
        and digest == NEON_UI_PLATFORM_PIN
    )


def upgrade_private_ui(
    connection: Connection[Any], *, target: base.PrivateTarget,
    before_commit: Callable[[], None] | None = None,
) -> None:
    """Keep v1 sessions, requests and accounting; an unknown catalog is never migrated."""
    if type(target) is not base.PrivateTarget or target.schema_version != 2:
        raise AccessRejected("PRIVATE_UI_TARGET_VERSION")
    base.check_connection(connection, target, target.owner)
    if connection.pgconn.transaction_status != TransactionStatus.IDLE:
        raise AccessRejected("PRIVATE_UI_OWNER_TRANSACTION")
    old = replace(target, schema_version=1)
    with connection.transaction():
        connection.execute("SET LOCAL search_path=pg_catalog")
        connection.execute("SET LOCAL statement_timeout='6s'")
        connection.execute("SET LOCAL lock_timeout='2s'")
        connection.execute("SELECT pg_advisory_xact_lock(671928041)")
        base.check_owner_identity(connection, target)
        connection.execute("LOCK TABLE astarter_private.metadata IN ACCESS EXCLUSIVE MODE")
        digest = base.private_catalog_digest(connection)
        if ui_catalog_matches(target.profile, digest):
            base.check_metadata(connection, target)
            return
        if digest != base.private_profile_pins(target.profile)[1]:
            raise AccessRejected("PRIVATE_UI_OLD_CATALOG")
        base.check_metadata(connection, old)
        addon = files(__package__).joinpath("private_ui_schema_v1.sql").read_text(encoding="utf-8")
        for statement in sql_statements(addon):
            connection.execute(statement)
        connection.execute(
            "UPDATE astarter_private.metadata SET schema_version=2,resource_sha256=%s "
            "WHERE singleton AND schema_version=1 AND resource_sha256=%s",
            (ui_resource_hash(), base.RESOURCE_SHA256),
        )
        if not ui_catalog_matches(target.profile, base.private_catalog_digest(connection)):
            raise AccessRejected("PRIVATE_UI_POST_CATALOG")
        base.check_metadata(connection, target)
        if before_commit is not None:
            before_commit()
