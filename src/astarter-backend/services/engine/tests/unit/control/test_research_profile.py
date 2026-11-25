"""Q08 profile selection is explicit and cannot bootstrap cloud connections."""

import importlib
import importlib.util

import pytest


def api():
    name = "stark_trading_os.control.postgres.research_access"
    assert importlib.util.find_spec(name) is not None, "Research access contract is missing"
    return importlib.import_module(name)


def test_unverified_neon_profile_is_rejected_before_a_pool_is_constructed(monkeypatch):
    q = api()
    from stark_trading_os.control.postgres import pool
    from stark_trading_os.control.postgres.synthetic_migration import TargetProfile

    def forbidden(*args, **kwargs):
        raise AssertionError("pool constructor must not run")

    monkeypatch.setattr(pool, "ConnectionPool", forbidden)
    with pytest.raises(q.AccessRejected, match="PROFILE_UNVERIFIED"):
        pool.PgRepositoryPool(
            "host=unreachable.invalid",
            profile=TargetProfile.NEON_PG17_V1,
            access_contract=q.RepositoryAccessContract.Q08_RESEARCH_STUB_V1,
        )


@pytest.mark.parametrize("raw", ["Q08_RESEARCH_STUB_V1", None, True])
def test_request_values_cannot_select_a_repository_contract(raw):
    api()
    from stark_trading_os.control.postgres.pool import PgRepositoryPool

    with pytest.raises(ValueError):
        PgRepositoryPool("", access_contract=raw)


def test_existing_pool_defaults_to_original_reference_contract_without_opening():
    q = api()
    from stark_trading_os.control.postgres.pool import PgRepositoryPool

    p = PgRepositoryPool("")
    assert p.access_contract is q.RepositoryAccessContract.PG2_REFERENCE_V1
    p.close()


@pytest.mark.parametrize("raw", ["LOCAL_PG17", None, True])
def test_untrusted_target_profile_is_not_coerced(raw):
    q = api()
    with pytest.raises(q.AccessRejected):
        q.research_profile_pin(raw)


def test_unknown_or_unverified_profile_cannot_generate_migration_statements():
    q = api()
    from stark_trading_os.control.postgres.synthetic_migration import TargetProfile

    with pytest.raises(q.AccessRejected, match="PROFILE_UNVERIFIED"):
        q.research_migration_statements(None, target_profile=TargetProfile.NEON_PG17_V1)


def test_resource_mismatch_rejects_migration_instead_of_learning_a_new_pin(monkeypatch):
    q = api()
    monkeypatch.setattr(q, "RESEARCH_RESOURCE_SHA256", "0" * 64)
    with pytest.raises(q.AccessRejected, match="RESOURCE"):
        q.research_resources()
