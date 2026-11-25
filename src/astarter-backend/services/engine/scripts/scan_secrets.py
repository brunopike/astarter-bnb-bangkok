"""Fail closed on detect-secrets findings without printing candidate values."""

from __future__ import annotations

import argparse
import ast
import hashlib
import hmac
import json
import re
import subprocess
import sys
from pathlib import Path


class SecretScanError(RuntimeError):
    """The repository could not be scanned under the fixed local policy."""


_HEX_CANDIDATE = re.compile(r"(?i)(?<![0-9a-f])[0-9a-f]{32,}(?![0-9a-f])")
_LOCK_INTEGRITY = re.compile(r"^\s+resolution: \{integrity: sha512-[A-Za-z0-9+/]{80,}={0,2}\}\s*$")
_ACTION_PIN = re.compile(
    r"^\s*-?\s*uses:\s*[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+@(?P<value>[0-9a-f]{40})\s*$"
)
_SOURCE_ALLOWLIST_FILTER = "detect_secrets.filters.allowlist.is_line_allowlisted"
_ENGINE_COMMIT_CONTEXT = re.compile(
    r"(?:ENGINE_COMMIT|PINNED_ENGINE_TAG_COMMIT|engine_(?:tag_)?commit|tag_commit)"
)
_PUBLIC_PAYLOAD_HASH_CONTEXT = re.compile(
    r"(?:EMPTY_SHA256|stderr_sha256|[\"']sha256[\"'])"
)
# Reviewed synthetic HTTP capture, including content digests and a simulated spawn nonce.
# Any byte change requires review and a deliberate new pin; this is not a directory allowance.
_HISTORICAL_HTTP_FIXTURE_SHA256 = "9502e5280b2290caf31df70c79838e83276e6f66ea35220f1be477b59bf5cab9"
_HISTORICAL_HTTP_FIXTURE = "services/engine/tests/fixtures/historical_http_v1.json"


# Public literals reviewed at exact source bytes and AST/JSON slots, not file exemptions.
# PG catalog pins are reviewed public comparisons, not catalogs recomputed by this scanner.
_REVIEWED_LITERAL_SOURCE_SHA256: dict[str, str] = {
    "services/engine/src/stark_trading_os/control/postgres/access.py":
        "fee17720aa43306cff8b8434567dfdba3c5f42d70ca94483c6affeffc288b4fd",
    "services/engine/src/stark_trading_os/control/postgres/public_access.py":
        "e2e1d30b11f971499b44af0b8800e286968dd96c5c02868fe28e2c3ac3bd106d",
    "services/engine/src/stark_trading_os/control/postgres/research_access.py":
        "7b1431ae2d8e4894b64e8f58c119cb6e119152f18ec11f4b3db3f159b654780e",
    "services/engine/src/stark_trading_os/control/postgres/synthetic_migration.py":
        "93f10562848319c41506e1b9ca236bf7ef45573cdcffa2aa066979bc865806be",
    "services/engine/src/stark_trading_os/domain/strategy_contracts.py":
        "1e6d2088c1d81f2716274cbb995232fb00569dae054cbc97153cf66214e436e2",
    "services/engine/tests/fixtures/q01_c_registry_v1.json":
        "9dfede38eab5ecfe2b77ee6588dda601e8954230a88055a1f414ea7da71258b4",
    "services/engine/tests/fixtures/q08_a1_btc_v1.json":
        "2f59273276f64a2919d686736c57bea615870cd3a4da5e93bed9472fcb5b9e84",
    "services/engine/tests/integration/control/test_public_live.py":
        "66dbaa5c164f6e66bcc6d9e10813842051abbb15f53edc20fbb759a72761b578",
    "services/engine/tests/integration/control/test_public_pg.py":
        "aa99b65bdb5e69c3e28ab776dcdf871aa6778bab782da367b1470247bce10b1d",
    "services/engine/tests/integration/control/test_public_provider_wiring.py":
        "4a11ac2463ec3213b491eae46d4dac82d3b5e8956a7f4b6c406f599234f0efaf",
    "services/engine/tests/unit/control/test_public_data_collection.py":
        "e9c5cb24e8daac6b19561e9f1fa47e4ed67bb118872a79d3cf6e380b0a00ce1a",
    "services/engine/tests/unit/control/test_public_live_config.py":
        "bc67b8eed5b1b0121e43c6bec4211f7d88e258877015c822dcc674420d780356",
    "services/engine/tests/unit/control/test_s03_schema9_migration.py":
        "ec2f37ef0ba390428983b851f84a7dcfd47686002e50aca1b05991c661c5a3e5",
    "services/engine/tests/unit/domain/test_opportunity_recommendations.py":
        "7ad5b823af9343b1928b9b5bfd8588e66d0284c9f3bcfed15512feb05e2d0b7a",
}
_REVIEWED_PYTHON_LITERAL_SLOTS: dict[str, tuple[tuple[int, int], ...]] = {
    "services/engine/src/stark_trading_os/control/postgres/access.py": ((22, 30), (23, 32)),
    "services/engine/src/stark_trading_os/control/postgres/public_access.py": ((16, 21), (18, 26)),
    "services/engine/src/stark_trading_os/control/postgres/research_access.py": (
        (41, 23), (42, 27),
    ),
    "services/engine/src/stark_trading_os/control/postgres/synthetic_migration.py": (
        (33, 26), (34, 17), (35, 23), (49, 12),
        (50, 12),
    ),
    "services/engine/src/stark_trading_os/domain/strategy_contracts.py": (
        (27, 23), (39, 12), (41, 12), (43, 12),
        (45, 12), (47, 12), (49, 12), (51, 12),
        (53, 12), (55, 12), (57, 14), (59, 14),
        (61, 13), (63, 15), (65, 15), (67, 15),
        (69, 15), (71, 13), (73, 13), (75, 15),
    ),
    "services/engine/tests/integration/control/test_public_live.py": ((43, 31), (43, 70), (44, 76)),
    "services/engine/tests/integration/control/test_public_pg.py": ((64, 17),),
    "services/engine/tests/integration/control/test_public_provider_wiring.py": (
        (104, 30), (104, 69),
    ),
    "services/engine/tests/unit/control/test_public_data_collection.py": ((419, 34),),
    "services/engine/tests/unit/control/test_public_live_config.py": (
        (36, 28), (37, 27), (101, 27),
    ),
    "services/engine/tests/unit/control/test_s03_schema9_migration.py": ((186, 8),),
    "services/engine/tests/unit/domain/test_opportunity_recommendations.py": ((354, 54),),
}
_REVIEWED_JSON_LITERAL_FIELDS: dict[str, dict[int, str | None]] = {
    "services/engine/tests/fixtures/q01_c_registry_v1.json": {
        7: "source_sha256",
    },
    "services/engine/tests/fixtures/q08_a1_btc_v1.json": {
        27: "source_sha256",
        28: "defaults_sha256",
        115: None,
        128: "plan_sha256",
        632: "subject_sha256",
        633: "content_sha256",
    },
}


def _is_reviewed_historical_fixture(root: Path) -> bool:
    path = root / _HISTORICAL_HTTP_FIXTURE
    try:
        return (
            path.resolve() == path
            and path.is_file()
            and path.stat().st_size <= 262144
            and hashlib.sha256(path.read_bytes()).hexdigest() == _HISTORICAL_HTTP_FIXTURE_SHA256
        )
    except OSError:
        return False


def _matches_finding(value: str, finding: dict[str, object]) -> bool:
    expected = finding.get("hashed_secret")
    return type(expected) is str and hmac.compare_digest(
        hashlib.sha1(value.encode("utf-8")).hexdigest(),
        expected,
    )


def _line_for_finding(
    root: Path,
    path: str,
    finding: dict[str, object],
) -> str | None:
    line_number = finding.get("line_number")
    if type(line_number) is not int or line_number < 1:
        return None
    try:
        lines = (root / path).read_text(encoding="utf-8").splitlines()
    except (OSError, UnicodeDecodeError):
        return None
    if line_number > len(lines):
        return None
    return lines[line_number - 1]


def _is_public_hex(
    *,
    root: Path,
    path: str,
    line: str,
    finding: dict[str, object],
) -> bool:
    candidates = tuple(
        candidate
        for candidate in _HEX_CANDIDATE.findall(line)
        if _matches_finding(candidate, finding)
    )
    if len(candidates) != 1:
        return False
    candidate = candidates[0]
    if _is_verified_source_digest(root, path, line, candidate, finding):
        return True
    if path == _HISTORICAL_HTTP_FIXTURE and _is_reviewed_historical_fixture(root):
        return True
    if (
        path == "services/engine/scripts/scan_secrets.py"
        and line == f'_HISTORICAL_HTTP_FIXTURE_SHA256 = "{candidate}"'
        and candidate == _HISTORICAL_HTTP_FIXTURE_SHA256
        and _is_reviewed_historical_fixture(root)
    ):
        return True
    engine_commit = "648970ce" + "64a304d9" + "3da0a293" + "20cb6e19" + "b905fa39"
    empty_sha256 = (
        "e3b0c442"
        + "98fc1c14"
        + "9afbf4c8"
        + "996fb924"
        + "27ae41e4"
        + "649b934c"
        + "a495991b"
        + "7852b855"
    )
    draft_cost_fill = {
        "cancel": None,
        "fee": None,
        "latency": None,
        "liquidity": None,
        "schema": "CostFillModel.v1",
        "slippage": None,
        "spread": None,
    }
    cost_fill_sha256 = hashlib.sha256(
        json.dumps(
            draft_cost_fill,
            ensure_ascii=False,
            allow_nan=False,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
    ).hexdigest()
    fixed_payload_hashes = {
        hashlib.sha256(payload).hexdigest() for payload in (b"", b"{}", b"audit\n", b"events\n")
    }
    if candidate == engine_commit:
        return _ENGINE_COMMIT_CONTEXT.search(line) is not None
    if candidate == cost_fill_sha256:
        return '"cost_fill_sha256"' in line or "'cost_fill_sha256'" in line
    if candidate in {empty_sha256, *fixed_payload_hashes}:
        return _PUBLIC_PAYLOAD_HASH_CONTEXT.search(line) is not None
    if candidate in _validated_fixture_hashes(root):
        return "manifest_sha256" in line or "record_hash" in line
    if (
        path == "services/engine/tests/fixtures/integrations/manifest.json"
        and re.fullmatch(r'\s*"sha256": "[0-9a-f]{64}"\s*,?\s*', line)
        and candidate in _validated_integration_fixture_hashes(root)
    ):
        return True
    if (
        path == "services/engine/tests/fixtures/data-model-ports-t2/manifest.v1.json"
        and re.fullmatch(r'\s*"sha256": "[0-9a-f]{64}"\s*,?\s*', line)
        and candidate in _validated_t2_fixture_hashes(root)
    ):
        return True
    if _is_verified_t3_fixture_digest(root, path, line, candidate):
        return True
    action = _ACTION_PIN.fullmatch(line)
    action_pins = {
        "3d3c42e5" + "aac5ba80" + "5825da76" + "410c1812" + "73ba90b1",
        "82076278" + "6026740c" + "76f36085" + "b0efc47a" + "31fe5020",
        "ea17c68d" + "f8912ef5" + "4335273c" + "149a84f5" + "6e3d413",
        "20cfd1bf" + "945f4377" + "ade1205e" + "4dbc1794" + "6fc9a30d",
        "043fb46d" + "1a93c77a" + "e656e7c1" + "c64a875d" + "1fc6a0a",
    }
    return (
        path.startswith(".github/workflows/")
        and action is not None
        and action.group("value") == candidate
        and candidate in action_pins
    )


def _canonical_object_bytes(value: object) -> bytes:
    return json.dumps(
        value,
        ensure_ascii=False,
        allow_nan=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")


def _validated_fixture_hashes(root: Path) -> set[str]:
    fixture_root = root / "data" / "fixtures"
    registry_path = fixture_root / "registry.json"
    if not registry_path.is_file():
        return set()
    try:
        registry = json.loads(registry_path.read_bytes())
        fixtures = registry["fixtures"]
        if type(fixtures) is not dict:
            return set()
        validated: set[str] = set()
        for fixture_id, entry in fixtures.items():
            if type(fixture_id) is not str or type(entry) is not dict:
                return set()
            relative_path = entry.get("relative_path")
            manifest_sha256 = entry.get("manifest_sha256")
            if type(relative_path) is not str or type(manifest_sha256) is not str:
                return set()
            manifest_path = fixture_root / relative_path / "manifest.json"
            if hashlib.sha256(manifest_path.read_bytes()).hexdigest() != manifest_sha256:
                return set()
            validated.add(manifest_sha256)
            quotes_path = fixture_root / relative_path / "quotes.jsonl"
            for raw_line in quotes_path.read_bytes().splitlines():
                record = json.loads(raw_line)
                if type(record) is not dict:
                    return set()
                record_hash = record.pop("record_hash", None)
                if type(record_hash) is not str:
                    return set()
                if hashlib.sha256(_canonical_object_bytes(record)).hexdigest() != record_hash:
                    return set()
                validated.add(record_hash)
        return validated
    except (KeyError, OSError, UnicodeDecodeError, json.JSONDecodeError):
        return set()


def _validated_integration_fixture_hashes(root: Path) -> set[str]:
    """Allow only the two synthetic fixture digests, rehashed at the exact manifest."""
    directory = root / "services/engine/tests/fixtures/integrations"
    names = {"binance_spot_ticker.json", "openrouter_research.json"}

    def unique_object(pairs: list[tuple[str, object]]) -> dict[str, object]:
        result: dict[str, object] = {}
        for key, value in pairs:
            if key in result:
                raise ValueError("duplicate manifest key")
            result[key] = value
        return result

    def bounded_file(path: Path) -> bytes:
        if path.is_symlink() or not path.is_file() or path.stat().st_size > 262144:
            raise ValueError("not a bounded regular fixture")
        return path.read_bytes()

    try:
        if directory.resolve() != directory:
            return set()
        manifest = json.loads(
            bounded_file(directory / "manifest.json"), object_pairs_hook=unique_object,
        )
        if (
            type(manifest) is not dict
            or set(manifest) != {"purpose", "origin", "license_scope", "files"}
            or manifest["purpose"] != "OFFLINE_FIXTURE"
            or type(manifest["origin"]) is not str
            or type(manifest["license_scope"]) is not str
            or type(manifest["files"]) is not list
            or len(manifest["files"]) != 2
        ):
            return set()
        seen: set[str] = set()
        validated: set[str] = set()
        for entry in manifest["files"]:
            if type(entry) is not dict or set(entry) != {"name", "sha256"}:
                return set()
            name, digest = entry["name"], entry["sha256"]
            if type(name) is not str or name not in names or name in seen:
                return set()
            if type(digest) is not str or re.fullmatch(r"[0-9a-f]{64}", digest) is None:
                return set()
            if hashlib.sha256(bounded_file(directory / name)).hexdigest() != digest:
                return set()
            seen.add(name)
            validated.add(digest)
        return validated
    except (OSError, UnicodeDecodeError, ValueError, RecursionError):
        return set()


def _is_verified_source_digest(
    root: Path, path: str, line: str, candidate: str, finding: dict[str, object],
) -> bool:
    """Recognize only actual byte digests at the fixed source-pin declarations."""
    relative: str | None = None
    if path == "services/engine/scripts/scan_secrets.py":
        try:
            declaration = root / path
            if (declaration.resolve(strict=True) != declaration or not declaration.is_file()
                    or declaration.stat().st_size > 262144):
                return False
            module = ast.parse(declaration.read_text(encoding="utf-8"))
            for node in module.body:
                if (not isinstance(node, ast.AnnAssign)
                        or not isinstance(node.target, ast.Name)
                        or node.target.id != "_REVIEWED_LITERAL_SOURCE_SHA256"
                        or not isinstance(node.value, ast.Dict)):
                    continue
                for key, value in zip(node.value.keys, node.value.values, strict=True):
                    if (isinstance(key, ast.Constant) and type(key.value) is str
                            and isinstance(value, ast.Constant) and value.value == candidate
                            and value.lineno == finding.get("line_number")
                            and _REVIEWED_LITERAL_SOURCE_SHA256.get(key.value) == candidate):
                        relative = key.value
        except (OSError, RuntimeError, SyntaxError, UnicodeDecodeError, RecursionError):
            return False
    elif path == "scripts/scan-forbidden-capabilities.mjs":
        match = re.fullmatch(r'  "([^"\n]+)": "([0-9a-f]{64})",', line)
        if match is None or match.group(2) != candidate:
            return False
        if match.group(1) in {
            "apps/web/src/app/api/v2/historical/[...segments]/route.ts",
            "apps/web/src/lib/bff/historical.ts",
            "services/engine/src/stark_trading_os/control/routes/historical.py",
            'services/engine/src/stark_trading_os/control/routes/assistant_tools.py',
            'services/engine/src/stark_trading_os/control/routes/public_data.py',
            'services/engine/src/stark_trading_os/control/routes/recommendations.py',
            'services/engine/src/stark_trading_os/control/routes/strategy_references.py',
            'services/engine/src/stark_trading_os/control/app.py',
            'services/engine/src/stark_trading_os/control/security.py',
            'services/engine/src/stark_trading_os/control/postgres/caller.py',
            'services/engine/src/stark_trading_os/control/postgres/identity.py',
        }:
            relative = match.group(1)
    if relative is None:
        return False
    source = root / relative
    try:
        return (
            source.resolve(strict=True) == source
            and source.is_file()
            and source.stat().st_size <= 262144
            and hashlib.sha256(source.read_bytes()).hexdigest() == candidate
        )
    except (OSError, RuntimeError):
        return False


def _is_reviewed_public_literal(
    root: Path, path: str, finding: dict[str, object],
) -> bool:
    if finding.get("type") not in {"Hex High Entropy String", "Secret Keyword"}:
        return False
    expected = _REVIEWED_LITERAL_SOURCE_SHA256.get(path)
    if expected is None:
        return False
    source = root / path
    try:
        if (source.resolve(strict=True) != source or not source.is_file()
                or source.stat().st_size > 262144):
            return False
        raw = source.read_bytes()
        if hashlib.sha256(raw).hexdigest() != expected:
            return False
        text = raw.decode("utf-8")
        line_number = finding.get("line_number")
        if type(line_number) is not int or line_number < 1:
            return False
        if path in _REVIEWED_PYTHON_LITERAL_SLOTS:
            slots = _REVIEWED_PYTHON_LITERAL_SLOTS[path]
            return any(
                isinstance(node, ast.Constant) and type(node.value) is str
                and node.lineno == line_number and (node.lineno, node.col_offset) in slots
                and _matches_finding(node.value, finding)
                for node in ast.walk(ast.parse(text))
            )
        fields = _REVIEWED_JSON_LITERAL_FIELDS.get(path, {})
        if line_number not in fields:
            return False
        field = fields[line_number]
        prefix = "" if field is None else re.escape(json.dumps(field)) + r": "
        match = re.fullmatch(r'\s*' + prefix + r'"([0-9a-f]{64})",?\s*',
                             text.splitlines()[line_number - 1])
        return match is not None and _matches_finding(match.group(1), finding)
    except (OSError, UnicodeDecodeError, SyntaxError, RecursionError, IndexError):
        return False


def _validated_t2_fixture_hashes(root: Path) -> set[str]:
    """Rehash the two exact T2 fixtures; do not exempt their contents from scanning."""
    directory = root / "services/engine/tests/fixtures/data-model-ports-t2"
    names = {"btcusdt-exchange-info.v1.json", "simulation-assumptions.v1.json"}

    def unique_object(pairs: list[tuple[str, object]]) -> dict[str, object]:
        result: dict[str, object] = {}
        for key, value in pairs:
            if key in result:
                raise ValueError("duplicate manifest key")
            result[key] = value
        return result

    def bounded_file(path: Path) -> bytes:
        if path.resolve(strict=True) != path or not path.is_file() or path.stat().st_size > 262144:
            raise ValueError("not a bounded ordinary fixture")
        return path.read_bytes()

    try:
        manifest = json.loads(
            bounded_file(directory / "manifest.v1.json"), object_pairs_hook=unique_object,
        )
        if (
            type(manifest) is not dict
            or set(manifest) != {"schema", "purpose", "source", "files"}
            or manifest["schema"] != "DataModelPortsT2Fixture.v1"
            or manifest["purpose"] != "OFFLINE_FIXTURE"
            or manifest["source"] != (
                "Human-authored synthetic test data; not an exchange response or product default."
            )
            or type(manifest["files"]) is not list
            or len(manifest["files"]) != 2
        ):
            return set()
        seen: set[str] = set()
        validated: set[str] = set()
        for entry in manifest["files"]:
            if type(entry) is not dict or set(entry) != {"path", "sha256"}:
                return set()
            name, digest = entry["path"], entry["sha256"]
            if type(name) is not str or name not in names or name in seen:
                return set()
            if type(digest) is not str or re.fullmatch(r"[0-9a-f]{64}", digest) is None:
                return set()
            if hashlib.sha256(bounded_file(directory / name)).hexdigest() != digest:
                return set()
            seen.add(name)
            validated.add(digest)
        return validated
    except (OSError, UnicodeDecodeError, ValueError, RuntimeError):
        return set()


def _is_verified_t3_fixture_digest(root: Path, path: str, line: str, candidate: str) -> bool:
    """Recompute exact synthetic payload hashes without exempting fixture contents."""
    relative = "services/engine/tests/fixtures/data-model-ports-t3"
    if path not in {f"{relative}/manifest.v1.json", f"{relative}/scenarios.v1.json"}:
        return False
    digest_line = re.compile(
        r'\s*"(sha256|utf8_sha256|system_sha256|schema_sha256)": "([0-9a-f]{64})"\s*,?\s*'
    )
    match = digest_line.fullmatch(line)
    if match is None or match.group(2) != candidate:
        return False
    directory = root / relative

    def unique_object(pairs: list[tuple[str, object]]) -> dict[str, object]:
        result: dict[str, object] = {}
        for key, value in pairs:
            if key in result:
                raise ValueError("duplicate fixture key")
            result[key] = value
        return result

    def bounded_file(name: str) -> bytes:
        source = directory / name
        if source.resolve(strict=True) != source or not source.is_file():
            raise ValueError("not an ordinary fixture")
        if source.stat().st_size > 262144:
            raise ValueError("oversized fixture")
        return source.read_bytes()

    try:
        manifest = json.loads(bounded_file("manifest.v1.json"), object_pairs_hook=unique_object)
        if (
            type(manifest) is not dict
            or set(manifest) != {"schema", "purpose", "source", "files"}
            or manifest["schema"] != "T3_FIXTURE_MANIFEST_V1"
            or manifest["purpose"] != "OFFLINE_FIXTURE"
            or manifest["source"] != "synthetic-only-no-provider-prices"
            or type(manifest["files"]) is not list
            or len(manifest["files"]) != 1
        ):
            return False
        entry = manifest["files"][0]
        if (
            type(entry) is not dict
            or set(entry) != {"name", "sha256"}
            or entry["name"] != "scenarios.v1.json"
        ):
            return False
        payload = bounded_file("scenarios.v1.json")
        payload_digest = hashlib.sha256(payload).hexdigest()
        if entry["sha256"] != payload_digest:
            return False
        scenario = json.loads(payload, object_pairs_hook=unique_object)
        if (
            type(scenario) is not dict
            or scenario["schema"] != "T3_SYNTHETIC_SCENARIOS_V1"
            or scenario["purpose"] != "OFFLINE_FIXTURE"
            or type(scenario["request"]) is not dict
        ):
            return False
        request = scenario["request"]
        task, policy, bindings = request["task"], request["policy"], request["bindings"]
        if type(task) is not dict or type(policy) is not dict or type(bindings) is not list:
            return False
        evidence = task["evidence"]
        if type(evidence) is not list or not 1 <= len(evidence) == len(bindings) <= 8:
            return False
        texts: dict[str, str] = {}
        for item in evidence:
            if (
                type(item) is not dict
                or type(item["evidence_id"]) is not str
                or not item["evidence_id"]
                or item["evidence_id"] in texts
                or type(item["text"]) is not str
            ):
                return False
            texts[item["evidence_id"]] = item["text"]
        expected: dict[tuple[str | int, ...], str] = {}
        seen: set[str] = set()
        for index, binding in enumerate(bindings):
            if type(binding) is not dict or type(binding["evidence_id"]) is not str:
                return False
            evidence_id = binding["evidence_id"]
            if evidence_id not in texts or evidence_id in seen:
                return False
            digest = hashlib.sha256(texts[evidence_id].encode("utf-8")).hexdigest()
            if binding["utf8_sha256"] != digest:
                return False
            seen.add(evidence_id)
            expected["request", "bindings", index, "utf8_sha256"] = digest
        if policy["renderer_revision"] != "FIXTURE_REQUEST_V1":
            return False
        for field, public_bytes in (
            ("system_sha256", b"fixture-system"), ("schema_sha256", b"fixture-schema"),
        ):
            digest = hashlib.sha256(public_bytes).hexdigest()
            if policy[field] != digest:
                return False
            expected["request", "policy", field] = digest
        # Use decoded paths: spelling/escaping cannot move a recognized digest field.
        actual: dict[tuple[str | int, ...], str] = {}

        def collect(value: object, location: tuple[str | int, ...] = ()) -> None:
            if type(value) is dict:
                for key, child in value.items():
                    child_path = (*location, key)
                    if key in {"sha256", "utf8_sha256", "system_sha256", "schema_sha256"}:
                        if type(child) is not str:
                            raise ValueError("not a digest string")
                        actual[child_path] = child
                    collect(child, child_path)
            elif type(value) is list:
                for index, child in enumerate(value):
                    collect(child, (*location, index))

        collect(scenario)
        if actual != expected:
            return False
        if path.endswith("/manifest.v1.json"):
            return match.group(1) == "sha256" and candidate == payload_digest
        return (match.group(1), candidate) in {(key[-1], value) for key, value in expected.items()}
    except (OSError, ValueError, KeyError, TypeError, RecursionError, RuntimeError):
        return False


def _is_placeholder_basic_auth(
    *,
    path: str,
    line: str,
    finding: dict[str, object],
) -> bool:
    expected: tuple[str, str] | None = None
    if path == "apps/web/src/lib/bff/__tests__/authority.test.ts":
        expected = (
            '["http'
            + ":"
            + "//"
            + "user"
            + ":"
            + "pass"
            + '@127.0.0.1:8765", "invalid control URL"],',
            "pass",
        )
    elif path == "apps/web/src/lib/chain/__tests__/observer.test.ts":
        expected = (
            '["userinfo", { ...publicInputs, rpcUrl: "https'
            + ":"
            + "//"
            + "name"
            + ":"
            + "pass"
            + '@rpc.example.test/v1" }],',
            "pass",
        )
    return (
        expected is not None
        and line.strip() == expected[0]
        and _matches_finding(expected[1], finding)
    )


def _is_narrow_non_secret(
    *,
    root: Path,
    path: str,
    finding: dict[str, object],
) -> bool:
    finding_type = finding.get("type")
    line = _line_for_finding(root, path, finding)
    if type(finding_type) is not str or line is None:
        return False
    if _is_reviewed_public_literal(root, path, finding):
        return True
    if finding_type == "Base64 High Entropy String":
        return path == "pnpm-lock.yaml" and _LOCK_INTEGRITY.fullmatch(line) is not None
    if finding_type == "Hex High Entropy String":
        return _is_public_hex(root=root, path=path, line=line, finding=finding)
    if finding_type == "Basic Auth Credentials":
        return _is_placeholder_basic_auth(path=path, line=line, finding=finding)
    if finding_type == "Secret Keyword":
        example_line = (
            f'value | {{{json.dumps("secret")}: {json.dumps("example")}}}, '
            'sort_keys=True, separators=(",", ":")'
        )
        if (
            path == "services/engine/tests/unit/runner/test_historical_protocol.py"
            and line.strip() == example_line
            and _matches_finding("example", finding)
        ):
            return True
        sentinel = "must-" + "not-render"
        return (
            path == "apps/web/src/components/cockpit/__tests__/app-shell.test.tsx"
            and "rejected_secret" in line
            and sentinel in line
            and _matches_finding(sentinel, finding)
        )
    if finding_type == "JSON Web Token":
        token_prefix = "eyJhbGciOiJIUzI1NiJ9" + ".eyJzdWIiOiIxMjMifQ"
        token = token_prefix + ".signature"
        return (
            path == "services/engine/tests/integration/control/test_runner_failures.py"
            and line.strip() == f'b"value={token}\\n",'
            and _matches_finding(token_prefix + ".", finding)
        )
    return False


def repository_files(root: Path) -> tuple[str, ...]:
    completed = subprocess.run(
        [
            "git",
            "-C",
            str(root),
            "ls-files",
            "--cached",
            "--others",
            "--exclude-standard",
            "-z",
        ],
        check=False,
        capture_output=True,
    )
    if completed.returncode != 0:
        raise SecretScanError("secret scan root is not a readable Git worktree")
    try:
        files = tuple(item.decode("utf-8") for item in completed.stdout.split(b"\0") if item)
    except UnicodeDecodeError as error:
        raise SecretScanError("Git returned a non-UTF-8 repository path") from error
    if not files:
        raise SecretScanError("secret scan found no tracked or relevant new files")
    # detect-secrets can silently return no findings when a directory-shaped
    # argument is mixed into the file list. Reject an unsupported inventory
    # before invoking it, including symlinks in any parent component.
    for relative in files:
        path = root / relative
        try:
            ordinary = (
                not Path(relative).is_absolute()
                and ".." not in Path(relative).parts
                and path.resolve(strict=True) == path
                and path.is_file()
            )
        except (OSError, RuntimeError):
            ordinary = False
        if not ordinary:
            raise SecretScanError("secret scan requires existing ordinary files without symlinks")
    return files


def scan(root: Path) -> int:
    files = repository_files(root)
    completed = subprocess.run(
        [
            sys.executable,
            "-m",
            "detect_secrets",
            "scan",
            "--no-verify",
            "--disable-filter",
            _SOURCE_ALLOWLIST_FILTER,
            "--",
            *files,
        ],
        cwd=root,
        check=False,
        capture_output=True,
    )
    if completed.returncode != 0:
        raise SecretScanError("detect-secrets did not complete")
    try:
        result = json.loads(completed.stdout)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise SecretScanError("detect-secrets returned an invalid result") from error
    if type(result) is not dict or type(result.get("results")) is not dict:
        raise SecretScanError("detect-secrets result schema is invalid")
    plugins = result.get("plugins_used")
    if type(plugins) is not list:
        raise SecretScanError("detect-secrets plugin inventory is unavailable")
    plugin_names = {
        item.get("name") for item in plugins if type(item) is dict and type(item.get("name")) is str
    }
    if not {"Base64HighEntropyString", "HexHighEntropyString"}.issubset(plugin_names):
        raise SecretScanError("required entropy detectors are unavailable")
    filters = result.get("filters_used")
    if type(filters) is not list or any(
        type(item) is not dict or type(item.get("path")) is not str
        for item in filters
    ):
        raise SecretScanError("detect-secrets filter inventory is unavailable")
    filter_paths = {item["path"] for item in filters}
    if any(path.startswith("detect_secrets.filters.allowlist.") for path in filter_paths):
        raise SecretScanError("source allowlist filters must be disabled")
    finding_count = 0
    for path, findings in result["results"].items():
        if type(path) is not str or type(findings) is not list:
            raise SecretScanError("detect-secrets finding schema is invalid")
        for finding in findings:
            if type(finding) is not dict:
                raise SecretScanError("detect-secrets finding schema is invalid")
            if not _is_narrow_non_secret(
                root=root,
                path=path,
                finding=finding,
            ):
                finding_count += 1
    if finding_count:
        print(
            f"secret scan failed: {finding_count} candidate(s) detected; values withheld",
            file=sys.stderr,
        )
        return 1
    print(f"secret scan passed: {len(files)} tracked/relevant-new file(s)")
    return 0


def _arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--root",
        type=Path,
        default=Path(__file__).resolve().parents[3],
        help=argparse.SUPPRESS,
    )
    return parser.parse_args()


def main() -> int:
    try:
        root = _arguments().root.resolve(strict=True)
        return scan(root)
    except (OSError, SecretScanError) as error:
        print(str(error), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
