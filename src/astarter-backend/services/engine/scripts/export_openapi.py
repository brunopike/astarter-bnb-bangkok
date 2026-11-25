"""Export the canonical local control OpenAPI snapshot."""

from __future__ import annotations

import argparse
from pathlib import Path

from stark_trading_os.audit.canonical_json import canonical_json_bytes
from stark_trading_os.control.app import create_app

REPOSITORY_ROOT = Path(__file__).resolve().parents[3]
DEFAULT_OUTPUT = REPOSITORY_ROOT / "contracts" / "control.openapi.json"


def export_openapi(output: Path) -> None:
    payload = canonical_json_bytes(create_app(testing=True).openapi()) + b"\n"
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_bytes(payload)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    arguments = parser.parse_args()
    export_openapi(arguments.output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
