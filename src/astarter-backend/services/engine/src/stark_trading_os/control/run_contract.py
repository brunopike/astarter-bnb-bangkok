"""Closed run discriminator; consumers choose a contract before parsing evidence."""

from enum import StrEnum
from typing import cast


class RunContractKind(StrEnum):
    PROBE_V1 = "PROBE_V1"
    HISTORICAL_SMA_V2 = "HISTORICAL_SMA_V2"


class RunContractMismatch(ValueError):
    """A run cannot enter this consumer's input/protocol/report contract."""


def parse_run_contract(value: object) -> RunContractKind:
    if type(value) not in (str, RunContractKind):
        raise RunContractMismatch("run contract is invalid")
    try:
        return RunContractKind(cast(str, value))
    except ValueError as error:
        raise RunContractMismatch("run contract is invalid") from error


def require_probe_contract(kind: RunContractKind) -> None:
    if parse_run_contract(kind) is not RunContractKind.PROBE_V1:
        raise RunContractMismatch("run contract is unsupported by this consumer")


def require_historical_contract(kind: RunContractKind) -> None:
    if parse_run_contract(kind) is not RunContractKind.HISTORICAL_SMA_V2:
        raise RunContractMismatch("run contract is unsupported by this consumer")
