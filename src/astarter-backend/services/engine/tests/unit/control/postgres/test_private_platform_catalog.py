"""Exact Neon-v2 catalog compatibility; synthetic protocol tests, no cloud."""

import contextlib
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from psycopg.pq import TransactionStatus

from stark_trading_os.control.postgres import private_research_access as access
from stark_trading_os.control.postgres import private_research_migration as migration
from stark_trading_os.control.postgres import private_ui_migration as ui

ORIGINAL_PIN = "d5242c0c184e888c7b8e23c305036e3c3c679af814ffaca430fd04b6f7fbcd19"
PLATFORM_PIN = "6fd8ee3d17863eeeb467afcf15296973178f1da8352d5e9766210716d336f95c"


def matches(profile, digest):
    return ui.ui_catalog_matches(profile, digest)


class PlatformCatalogMixin:
    def test_original_neon_and_local_catalog_remain_accepted(self):
        for profile in (migration.TargetProfile.LOCAL_PG17, migration.TargetProfile.NEON_PG17_V1):
            self.assertTrue(matches(profile, ORIGINAL_PIN))

    def test_exact_platform_catalog_is_accepted_only_for_neon_v2(self):
        self.assertTrue(matches(migration.TargetProfile.NEON_PG17_V1, PLATFORM_PIN))
        self.assertFalse(matches(migration.TargetProfile.LOCAL_PG17, PLATFORM_PIN))

    def test_all11_extra_public_and_changed_grant_option_are_rejected(self):
        for digest in (
            "1bf0ca6dd8c113c3a6be5a9a876102f5e2b70a49144708bfafb10c4f6927cace",
            "01ddac7852b76fc031d80a1387eb8d0bdc45e675e4aa5c5a2722fcadda9b52e7",
            "71527c015168ce2f56652b22fa8e9e6aa8da4a00b8f21b19b99d234ed37e4578",
            "0" * 64,
        ):
            self.assertFalse(matches(migration.TargetProfile.NEON_PG17_V1, digest))

    def ui_case(self, digests):
        statements, metadata, committed = ([], [], [])

        class Connection:
            pgconn = SimpleNamespace(transaction_status=TransactionStatus.IDLE)

            def transaction(self):
                return contextlib.nullcontext()

            def execute(self, statement, *args):
                statements.append(statement)

        target = migration.PrivateTarget(
            migration.TargetProfile.NEON_PG17_V1,
            "ep-fixture.us-east-2.aws.neon.tech",
            5432,
            "fixture_private",
            "fixture_owner",
            "fixture_runtime",
            "fixture_issuer",
            "fixture_cost",
            "SYNTHETIC_UI_PROTOCOL_ONLY",
            schema_version=2,
        )
        with (
            patch.object(migration, "check_connection"),
            patch.object(migration, "check_owner_identity"),
            patch.object(
                migration,
                "check_metadata",
                side_effect=lambda connection, target: metadata.append(target.schema_version),
            ),
            patch.object(migration, "private_catalog_digest", side_effect=digests),
        ):
            ui.upgrade_private_ui(
                Connection(), target=target, before_commit=lambda: committed.append(True)
            )
        return (statements, metadata, committed)

    def test_existing_platform_v2_is_idempotent_without_ddl(self):
        statements, metadata, committed = self.ui_case([PLATFORM_PIN])
        self.assertEqual(metadata, [2])
        self.assertEqual(committed, [])
        self.assertFalse(any(s.startswith(("CREATE", "ALTER", "UPDATE")) for s in statements))

    def test_forward_upgrade_postcondition_accepts_exact_platform_catalog(self):
        statements, metadata, committed = self.ui_case(
            [
                migration.private_profile_pins(migration.TargetProfile.NEON_PG17_V1, 1)[1],
                PLATFORM_PIN,
            ]
        )
        self.assertEqual(metadata, [1, 2])
        self.assertEqual(committed, [True])
        self.assertTrue(any(s.startswith("UPDATE astarter_private.metadata") for s in statements))

    def test_unknown_v3_and_coerced_version_stay_rejected(self):
        for version in (3, True, "2", 2.0):
            with self.assertRaises(migration.AccessRejected):
                migration.private_profile_pins(migration.TargetProfile.NEON_PG17_V1, version)

    def test_original_pins_and_v1_profiles_are_unchanged(self):
        self.assertEqual(ui.NEON_UI_PIN, ORIGINAL_PIN)
        self.assertEqual(ui.LOCAL_UI_PIN, ORIGINAL_PIN)
        for profile in (migration.TargetProfile.LOCAL_PG17, migration.TargetProfile.NEON_PG17_V1):
            self.assertNotEqual(migration.private_profile_pins(profile, 1)[1], PLATFORM_PIN)
            self.assertEqual(migration.private_profile_pins(profile, 2)[1], ORIGINAL_PIN)

    def test_resource_tamper_is_rejected_before_either_catalog_is_accepted(self):
        with patch.object(ui, "UI_RESOURCE_SHA256", "0" * 64):
            for digest in (ORIGINAL_PIN, PLATFORM_PIN):
                with self.assertRaises(migration.AccessRejected):
                    matches(migration.TargetProfile.NEON_PG17_V1, digest)

    def test_bad_connection_is_not_bypassed_by_catalog_compatibility(self):
        target = SimpleNamespace(
            runtime="fixture_runtime",
            profile=migration.TargetProfile.NEON_PG17_V1,
            schema_version=2,
        )
        with (
            patch.object(
                access,
                "check_connection",
                side_effect=migration.AccessRejected("PRIVATE_CONNECTION_REJECTED"),
            ),
            patch.object(access, "private_catalog_digest") as digest,
        ):
            with self.assertRaisesRegex(migration.AccessRejected, "PRIVATE_CONNECTION_REJECTED"):
                access.verify_private_access(object(), target=target, role="runtime")
            digest.assert_not_called()

    def test_unknown_profile_does_not_get_platform_compatibility(self):
        with self.assertRaises(migration.AccessRejected):
            matches(object(), PLATFORM_PIN)

    def test_unset_optional_platform_pin_stays_closed(self):
        with patch.object(ui, "NEON_UI_PLATFORM_PIN", None):
            self.assertFalse(matches(migration.TargetProfile.NEON_PG17_V1, PLATFORM_PIN))
            self.assertFalse(matches(migration.TargetProfile.NEON_PG17_V1, None))
            self.assertTrue(matches(migration.TargetProfile.NEON_PG17_V1, ORIGINAL_PIN))

    def test_schema3_retains_its_local_pin_and_unverified_neon_stays_closed(self):
        from stark_trading_os.control.postgres import private_draft_migration as drafts

        self.assertIsNone(drafts.NEON_DRAFT_PIN)
        self.assertEqual(
            migration.private_profile_pins(migration.TargetProfile.LOCAL_PG17, 3)[1],
            drafts.LOCAL_DRAFT_PIN,
        )
        self.assertNotEqual(drafts.LOCAL_DRAFT_PIN, PLATFORM_PIN)


class PlatformCatalogTests(PlatformCatalogMixin, unittest.TestCase):
    def runtime_case(
        self,
        profile,
        version,
        digest_value,
        *,
        accepted=True,
        dangerous=False,
        metadata_error=None,
        role="runtime",
    ):
        target = migration.PrivateTarget(
            profile,
            "/synthetic/socket"
            if profile is migration.TargetProfile.LOCAL_PG17
            else "ep-fixture.us-east-2.aws.neon.tech",
            5432,
            "fixture_private",
            "fixture_owner",
            "fixture_runtime",
            "fixture_issuer",
            "fixture_cost",
            "SYNTHETIC_RUNTIME_PROTOCOL_ONLY",
            schema_version=version,
        )
        user = getattr(target, role)
        rows = iter(
            [
                {"path": "pg_catalog"},
                {"db": target.database, "role": user, "login": user, "safe": True, "major": 17},
                {"connected": True, "usable": True, "unsafe": False},
                [],
            ]
        )

        class Connection:
            pgconn = SimpleNamespace(transaction_status=TransactionStatus.INTRANS)

            def execute(self, *args, **kwargs):
                self.row = next(rows)
                return self

            def fetchone(self):
                return self.row

            def fetchall(self):
                return self.row

        with (
            patch.object(
                access,
                "check_connection",
                side_effect=lambda connection, actual, user: migration.private_profile_pins(
                    actual.profile, actual.schema_version
                ),
            ),
            patch.object(
                access,
                "_read_pair",
                side_effect=[
                    ([{"rolname": migration.CAPABILITIES[role], "unsafe": False}], []),
                    ([{"present": True}] if dangerous else [], []),
                ],
            ),
            patch.object(access, "private_catalog_digest", return_value=digest_value) as digest,
            patch.object(access, "check_metadata", side_effect=metadata_error) as metadata,
        ):
            if accepted:
                access.verify_private_access(Connection(), target=target, role=role)
                metadata.assert_called_once()
            else:
                code = "PRIVATE_METADATA_MISMATCH" if metadata_error else "PRIVATE_CATALOG_MISMATCH"
                with self.assertRaisesRegex(migration.AccessRejected, "^" + code + "$"):
                    access.verify_private_access(Connection(), target=target, role=role)
                if metadata_error:
                    metadata.assert_called_once()
                else:
                    metadata.assert_not_called()
            if dangerous:
                digest.assert_not_called()
            else:
                digest.assert_called_once()

    def test_runtime_profile_matrix_preserves_version_and_local_boundaries(self):
        local, neon = (migration.TargetProfile.LOCAL_PG17, migration.TargetProfile.NEON_PG17_V1)
        digests = [
            ORIGINAL_PIN,
            PLATFORM_PIN,
            migration.private_profile_pins(neon, 1)[1],
            "1bf0ca6dd8c113c3a6be5a9a876102f5e2b70a49144708bfafb10c4f6927cace",
            "01ddac7852b76fc031d80a1387eb8d0bdc45e675e4aa5c5a2722fcadda9b52e7",
            "71527c015168ce2f56652b22fa8e9e6aa8da4a00b8f21b19b99d234ed37e4578",
            "0" * 64,
        ]
        for profile in (local, neon):
            for version in (1, 2):
                expected = migration.private_profile_pins(profile, version)[1]
                for role in ("runtime", "issuer", "cost"):
                    for digest in digests:
                        accepted = digest == expected or (
                            profile is neon and version == 2 and (digest == PLATFORM_PIN)
                        )
                        with self.subTest(
                            profile=profile.value, version=version, role=role, digest=digest
                        ):
                            self.runtime_case(
                                profile, version, digest, accepted=accepted, role=role
                            )

    def test_runtime_dangerous_permission_stops_before_digest(self):
        for role in ("runtime", "issuer", "cost"):
            self.runtime_case(
                migration.TargetProfile.NEON_PG17_V1,
                2,
                PLATFORM_PIN,
                accepted=False,
                dangerous=True,
                role=role,
            )

    def test_runtime_metadata_rejection_is_not_hidden(self):
        for role in ("runtime", "issuer", "cost"):
            self.runtime_case(
                migration.TargetProfile.NEON_PG17_V1,
                2,
                PLATFORM_PIN,
                accepted=False,
                role=role,
                metadata_error=migration.AccessRejected("PRIVATE_METADATA_MISMATCH"),
            )

    def test_runtime_rejects_alternative_platform_projections(self):
        for digest in (
            "1bf0ca6dd8c113c3a6be5a9a876102f5e2b70a49144708bfafb10c4f6927cace",
            "01ddac7852b76fc031d80a1387eb8d0bdc45e675e4aa5c5a2722fcadda9b52e7",
            "71527c015168ce2f56652b22fa8e9e6aa8da4a00b8f21b19b99d234ed37e4578",
            "0" * 64,
        ):
            self.runtime_case(migration.TargetProfile.NEON_PG17_V1, 2, digest, accepted=False)
