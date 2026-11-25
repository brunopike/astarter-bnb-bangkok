"""Explicit schema2 -> schema3; old resources and cloud profile proofs stay separate."""

from collections.abc import Callable
from dataclasses import replace
from hashlib import sha256
from importlib.resources import files
from typing import Any

from psycopg import Connection
from psycopg.pq import TransactionStatus

from . import private_research_migration as base
from .access import AccessRejected
from .private_ui_migration import ui_resource_hash
from .synthetic_migration import TargetProfile, sql_statements

# Independently created LOCAL PG17 golden, r3-local-oracle.json, 2026-11-17.
LOCAL_DRAFT_PIN: str | None = "714c11b6f5ce36b0e97e6e762f5b426bdbe264b5241288d70eb6f9aed3564895"
NEON_DRAFT_PIN: str | None = None
DRAFT_RESOURCE_SHA256: str | None = (
    "94d2781a8ad0fa23829b6f6982cebeed6a5f03af70628e7e8e1d0baa0904842f"
)


def draft_resource_hash() -> str:
    addon = files(__package__).joinpath("private_draft_schema_v1.sql").read_text(encoding="utf-8")
    actual = sha256((ui_resource_hash() + "\n--PRIVATE-DRAFT--\n" + addon).encode()).hexdigest()
    if DRAFT_RESOURCE_SHA256 is None or actual != DRAFT_RESOURCE_SHA256:
        raise AccessRejected("PRIVATE_DRAFT_RESOURCE_UNVERIFIED")
    return actual


def draft_profile_pin(profile: TargetProfile) -> str:
    pin = (
        LOCAL_DRAFT_PIN
        if profile is TargetProfile.LOCAL_PG17
        else (NEON_DRAFT_PIN if profile is TargetProfile.NEON_PG17_V1 else None)
    )
    if pin is None:
        raise AccessRejected("PRIVATE_DRAFT_PROFILE_UNVERIFIED")
    draft_resource_hash()
    return pin


def upgrade_private_drafts(
    connection: Connection[Any],
    *,
    target: base.PrivateTarget,
    before_commit: Callable[[], None] | None = None,
) -> None:
    if type(target) is not base.PrivateTarget or target.schema_version != 3:
        raise AccessRejected("PRIVATE_DRAFT_TARGET_VERSION")
    base.check_connection(connection, target, target.owner)
    if connection.pgconn.transaction_status != TransactionStatus.IDLE:
        raise AccessRejected("PRIVATE_DRAFT_OWNER_TRANSACTION")
    old = replace(target, schema_version=2)
    with connection.transaction():
        connection.execute("SET LOCAL search_path=pg_catalog")
        connection.execute("SET LOCAL statement_timeout='6s'")
        connection.execute("SET LOCAL lock_timeout='2s'")
        connection.execute("SELECT pg_advisory_xact_lock(671928041)")
        base.check_owner_identity(connection, target)
        connection.execute("LOCK TABLE astarter_private.metadata IN ACCESS EXCLUSIVE MODE")
        current = base.private_catalog_digest(connection)
        if current == draft_profile_pin(target.profile):
            base.check_metadata(connection, target)
            return
        if current != base.private_profile_pins(target.profile, 2)[1]:
            raise AccessRejected("PRIVATE_DRAFT_OLD_CATALOG")
        base.check_metadata(connection, old)
        addon = (
            files(__package__).joinpath("private_draft_schema_v1.sql").read_text(encoding="utf-8")
        )
        for statement in sql_statements(addon):
            connection.execute(statement)
        changed = connection.execute(
            "UPDATE astarter_private.metadata SET schema_version=3,resource_sha256=%s "
            "WHERE singleton AND schema_version=2 AND resource_sha256=%s RETURNING singleton",
            (draft_resource_hash(), ui_resource_hash()),
        ).fetchall()
        if changed != [{"singleton": True}]:
            raise AccessRejected("PRIVATE_DRAFT_METADATA_UPDATE")
        if base.private_catalog_digest(connection) != draft_profile_pin(target.profile):
            raise AccessRejected("PRIVATE_DRAFT_POST_CATALOG")
        base.check_metadata(connection, target)
        if before_commit is not None:
            before_commit()
