"""R3 upgrades only explicit owned LOCAL schema2 fixtures; Neon stays closed."""

import importlib
from dataclasses import replace

import pytest

from stark_trading_os.control.postgres import private_research_migration as base
from stark_trading_os.control.postgres.access import AccessRejected
from tests.unit.control.postgres.test_private_research_pool import target


def test_local_v3_is_explicit_and_old_target_versions_are_not_reinterpreted():
    old = target()
    assert old.schema_version == 1
    assert replace(old, schema_version=2).schema_version == 2
    new = replace(old, schema_version=3)
    assert new.schema_version == 3
    assert base.private_profile_pins(new.profile, 3)[1] not in {
        base.private_profile_pins(new.profile, 1)[1],
        base.private_profile_pins(new.profile, 2)[1],
    }


def test_unverified_neon_v3_has_no_local_pin_fallback():
    with pytest.raises(AccessRejected, match="PRIVATE_DRAFT_PROFILE_UNVERIFIED"):
        base.private_profile_pins(base.TargetProfile.NEON_PG17_V1, 3)


def test_existing_v1_v2_resource_pins_are_retained_and_v3_has_a_separate_resource():
    m = importlib.import_module("stark_trading_os.control.postgres.private_draft_migration")
    assert (
        base.RESOURCE_SHA256 == "acff7f2db95d2aedf3151e3ec64b2ae76e6dac9fea31e7dbc7b15c34c686610d"
    )
    assert base.private_profile_pins(base.TargetProfile.LOCAL_PG17, 2)[1] == (
        "d5242c0c184e888c7b8e23c305036e3c3c679af814ffaca430fd04b6f7fbcd19"
    )
    assert m.draft_resource_hash() != base.RESOURCE_SHA256
