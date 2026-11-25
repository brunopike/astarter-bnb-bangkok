"""Fresh-process controller recovery. No native restoration or dispatch authority."""

from __future__ import annotations

import argparse
import os
from dataclasses import asdict
from pathlib import Path

from stark_trading_os.control.astarter.strategy_repository import ScopeAssignment
from stark_trading_os.control.astarter.transaction_service import ControllerIdentity
from stark_trading_os.control.registry import ControlStore
from stark_trading_os.domain.astarter_simulation import encode
from stark_trading_os.domain.strategy_contracts import PrivateBinding
from stark_trading_os.runner.astarter_simulation import SyntheticControllerBackend


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--database", type=Path, required=True)
    parser.add_argument("--account", required=True)
    parser.add_argument("--tenant", required=True)
    parser.add_argument("--venue-session", required=True)
    parser.add_argument("--owner", required=True)
    parser.add_argument("--expected-fence", type=int, required=True)
    args = parser.parse_args()
    if not args.database.is_absolute() or not args.database.is_file():
        raise ValueError("ASTARTER_RECOVERY_EXISTING_DATABASE_REQUIRED")
    store = ControlStore.open(args.database)
    try:
        # Only the local finite fixture invokes this CLI. These arguments are
        # explicit CAS provenance, not a general-purpose login/authentication API.
        backend = SyntheticControllerBackend(ControllerIdentity(
            ScopeAssignment(
                binding=PrivateBinding(tenant_id=args.tenant, account_id=args.account,
                                       environment="OFFLINE"),
                venue_session=args.venue_session, authority_ref="SYNTHETIC-OWNERSHIP-NOT-AUTH",
            ), args.owner, args.expected_fence,
        ))
        control = backend.control(store)
        state = control.begin_recovery(args.account)
        print(
            encode(
                dict(
                    scope="CONTROLLER_RECOVERY_ONLY",
                    pid=os.getpid(),
                    account=asdict(state),
                    reservations=[asdict(v) for v in control.reservations(args.account)],
                )
            ).decode()
        )
    finally:
        store.close()


if __name__ == "__main__":
    main()
