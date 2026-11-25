from __future__ import annotations

import json
import subprocess
import sys
from hashlib import sha256
from pathlib import Path

import pytest

REPOSITORY_ROOT = Path(__file__).resolve().parents[4]
SCANNER = REPOSITORY_ROOT / "services" / "engine" / "scripts" / "scan_secrets.py"


def _run(root: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(SCANNER), "--root", str(root)],
        check=False,
        capture_output=True,
        text=True,
    )


def _git(root: Path, *args: str) -> None:
    subprocess.run(
        ["git", *args],
        cwd=root,
        check=True,
        capture_output=True,
        text=True,
    )


def test_secret_scan_accepts_tracked_and_untracked_safe_files(tmp_path: Path) -> None:
    _git(tmp_path, "init", "-q")
    (tmp_path / "tracked.txt").write_text("BACKTEST ONLY\n", encoding="utf-8")
    (tmp_path / "new.txt").write_text("no credential here\n", encoding="utf-8")
    _git(tmp_path, "add", "tracked.txt")

    result = _run(tmp_path)

    assert result.returncode == 0, result.stderr
    assert "secret scan passed" in result.stdout


def test_secret_scan_rejects_real_shaped_synthesized_untracked_secret(
    tmp_path: Path,
) -> None:
    _git(tmp_path, "init", "-q")
    synthesized = "AKIA" + ("A" * 16)
    (tmp_path / "candidate.txt").write_text(
        f"service_credential={synthesized}\n",
        encoding="utf-8",
    )

    result = _run(tmp_path)

    assert result.returncode == 1
    assert "secret scan failed" in result.stderr
    assert synthesized not in result.stdout
    assert synthesized not in result.stderr


@pytest.mark.parametrize("placement", ["inline", "nextline"])
def test_secret_scan_does_not_honor_source_allowlist_pragmas(
    tmp_path: Path,
    placement: str,
) -> None:
    _git(tmp_path, "init", "-q")
    synthesized = "AKIA" + ("E" * 16)
    payload = (
        f"service_credential={synthesized}  # pragma: allowlist secret\n"
        if placement == "inline"
        else f"# pragma: allowlist nextline secret\nservice_credential={synthesized}\n"
    )
    (tmp_path / "candidate.py").write_text(payload, encoding="utf-8")

    result = _run(tmp_path)

    assert result.returncode == 1
    assert "secret scan failed" in result.stderr
    assert synthesized not in result.stdout
    assert synthesized not in result.stderr


def test_secret_scan_accepts_only_proven_public_hash_and_lock_structures(
    tmp_path: Path,
) -> None:
    _git(tmp_path, "init", "-q")
    engine_commit = "648970ce" + "64a304d9" + "3da0a293" + "20cb6e19" + "b905fa39"
    fixture_digest = sha256(b"{}").hexdigest()
    integrity = (
        "YQfW7V0qRrKw3WZU"
        + "Nw6jFj8Qxq0D9e5M"
        + "r2Q4Vw9bD3Mm5Kp8"
        + "Nx2La6Cz7Te1Hs4P"
        + "q9Zu3Xv8Gc5Jr0Fy"
        + "6Bn2Aw=="
    )
    (tmp_path / "pins.py").write_text(
        f'PINNED_ENGINE_TAG_COMMIT = "{engine_commit}"\n'
        f'fixture = {{"sha256": "{fixture_digest}"}}\n',
        encoding="utf-8",
    )
    (tmp_path / "pnpm-lock.yaml").write_text(
        f"  package@1.0.0:\n    resolution: {{integrity: sha512-{integrity}}}\n",
        encoding="utf-8",
    )
    _git(tmp_path, "add", "pins.py", "pnpm-lock.yaml")

    result = _run(tmp_path)

    assert result.returncode == 0, result.stderr


def test_known_public_hash_is_not_allowed_in_an_unrelated_field(
    tmp_path: Path,
) -> None:
    _git(tmp_path, "init", "-q")
    engine_commit = "648970ce" + "64a304d9" + "3da0a293" + "20cb6e19" + "b905fa39"
    (tmp_path / "candidate.py").write_text(
        f'credential = "{engine_commit}"\n',
        encoding="utf-8",
    )
    _git(tmp_path, "add", "candidate.py")

    result = _run(tmp_path)

    assert result.returncode == 1
    assert engine_commit not in result.stdout
    assert engine_commit not in result.stderr


def test_public_digest_context_does_not_hide_a_real_shaped_credential(
    tmp_path: Path,
) -> None:
    _git(tmp_path, "init", "-q")
    synthesized = "AKIA" + ("B" * 16)
    engine_commit = "648970ce" + "64a304d9" + "3da0a293" + "20cb6e19" + "b905fa39"
    (tmp_path / "candidate.py").write_text(
        f'PINNED_ENGINE_TAG_COMMIT = "{engine_commit}"; '
        f'service_credential = "{synthesized}"\n',
        encoding="utf-8",
    )
    _git(tmp_path, "add", "candidate.py")

    result = _run(tmp_path)

    assert result.returncode == 1
    assert synthesized not in result.stdout
    assert synthesized not in result.stderr


def test_option_shaped_filename_cannot_change_detect_secrets_policy(
    tmp_path: Path,
) -> None:
    _git(tmp_path, "init", "-q")
    synthesized = "AKIA" + ("C" * 16)
    (tmp_path / "--baseline").write_text(synthesized, encoding="utf-8")
    _git(tmp_path, "add", "--", "--baseline")

    result = _run(tmp_path)

    assert result.returncode == 1
    assert synthesized not in result.stdout
    assert synthesized not in result.stderr


def test_lock_integrity_line_cannot_hide_an_additional_credential(
    tmp_path: Path,
) -> None:
    _git(tmp_path, "init", "-q")
    synthesized = "AKIA" + ("D" * 16)
    integrity = (
        "YQfW7V0qRrKw3WZU"
        + "Nw6jFj8Qxq0D9e5M"
        + "r2Q4Vw9bD3Mm5Kp8"
        + "Nx2La6Cz7Te1Hs4P"
        + "q9Zu3Xv8Gc5Jr0Fy"
        + "6Bn2Aw=="
    )
    (tmp_path / "pnpm-lock.yaml").write_text(
        f"    resolution: {{integrity: sha512-{integrity}, credential: {synthesized}}}\n",
        encoding="utf-8",
    )
    _git(tmp_path, "add", "pnpm-lock.yaml")

    result = _run(tmp_path)

    assert result.returncode == 1
    assert synthesized not in result.stdout
    assert synthesized not in result.stderr


def _integration_manifest(root: Path) -> tuple[Path, Path]:
    directory = root / "services/engine/tests/fixtures/integrations"
    directory.mkdir(parents=True)
    files = []
    for name in ("binance_spot_ticker.json", "openrouter_research.json"):
        payload = json.dumps({"purpose": "OFFLINE_FIXTURE", "fixture": name}).encode()
        (directory / name).write_bytes(payload)
        files.append({"name": name, "sha256": sha256(payload).hexdigest()})
    manifest = directory / "manifest.json"
    manifest.write_text(json.dumps({
        "purpose": "OFFLINE_FIXTURE", "origin": "Synthetic QA",
        "license_scope": "Project authored", "files": files,
    }, indent=2) + "\n")
    return directory, manifest


def test_integration_hashes_require_matching_fixture_bytes(tmp_path: Path) -> None:
    _git(tmp_path, "init", "-q")
    directory, _ = _integration_manifest(tmp_path)
    assert _run(tmp_path).returncode == 0
    (directory / "binance_spot_ticker.json").write_text('{"changed": true}\n')
    assert _run(tmp_path).returncode == 1


@pytest.mark.parametrize(
    "mutation", ["wrong_path", "wrong_field", "traversal", "symlink", "duplicate"],
)
def test_integration_hash_allowance_is_path_and_schema_bound(tmp_path: Path, mutation: str) -> None:
    _git(tmp_path, "init", "-q")
    directory, manifest = _integration_manifest(tmp_path)
    value = json.loads(manifest.read_text())
    if mutation == "wrong_path":
        (tmp_path / "copied.json").write_bytes(manifest.read_bytes())
    elif mutation == "wrong_field":
        value["files"][0]["credential"] = value["files"][0].pop("sha256")
        manifest.write_text(json.dumps(value, indent=2))
    elif mutation == "traversal":
        value["files"][0]["name"] = "../binance_spot_ticker.json"
        manifest.write_text(json.dumps(value, indent=2))
    elif mutation == "symlink":
        fixture = directory / "binance_spot_ticker.json"
        fixture.rename(tmp_path / "elsewhere.json")
        fixture.symlink_to(tmp_path / "elsewhere.json")
    else:
        manifest.write_text(
            manifest.read_text().replace('"purpose":', '"purpose": "OTHER", "purpose":', 1),
        )
    result = _run(tmp_path)
    # A symlink now fails the complete inventory before content classification.
    assert result.returncode == (2 if mutation == "symlink" else 1)


@pytest.mark.parametrize("placement", ["fixture", "manifest_line"])
def test_verified_integration_hash_does_not_hide_credential(tmp_path: Path, placement: str) -> None:
    _git(tmp_path, "init", "-q")
    directory, manifest = _integration_manifest(tmp_path)
    synthesized = "AKIA" + ("F" * 16)
    value = json.loads(manifest.read_text())
    if placement == "fixture":
        payload = json.dumps({"service_credential": synthesized}).encode()
        (directory / "binance_spot_ticker.json").write_bytes(payload)
        value["files"][0]["sha256"] = sha256(payload).hexdigest()
        manifest.write_text(json.dumps(value, indent=2))
    else:
        manifest.write_text(manifest.read_text().replace(
            '"sha256":', '"service_credential": "' + synthesized + '", "sha256":', 1,
        ))
    result = _run(tmp_path)
    assert result.returncode == 1
    assert synthesized not in result.stdout + result.stderr


@pytest.mark.parametrize("mutation", ["unchanged", "changed", "copied_path"])
def test_reviewed_historical_http_fixture_pin_is_exact(tmp_path: Path, mutation: str) -> None:
    _git(tmp_path, "init", "-q")
    relative = Path("services/engine/tests/fixtures/historical_http_v1.json")
    target = tmp_path / relative
    target.parent.mkdir(parents=True)
    target.write_bytes((REPOSITORY_ROOT / relative).read_bytes())
    if mutation == "changed":
        value = json.loads(target.read_text())
        value["source_head"] = sha256(b"not the captured source").hexdigest()
        target.write_text(json.dumps(value, indent=2) + "\n")
    elif mutation == "copied_path":
        (tmp_path / "copied.json").write_bytes(target.read_bytes())
    assert _run(tmp_path).returncode == (0 if mutation == "unchanged" else 1)


@pytest.mark.parametrize("replacement", [False, True])
def test_protocol_extra_field_placeholder_is_exact(tmp_path: Path, replacement: bool) -> None:
    _git(tmp_path, "init", "-q")
    relative = Path("services/engine/tests/unit/runner/test_historical_protocol.py")
    line = next(
        line for line in (REPOSITORY_ROOT / relative).read_text().splitlines()
        if "value | " in line and '"secret"' in line
    )
    synthesized = "AKIA" + ("G" * 16)
    if replacement:
        line = line.replace("example", synthesized)
    target = tmp_path / relative
    target.parent.mkdir(parents=True)
    target.write_text(line + "\n")
    result = _run(tmp_path)
    assert result.returncode == (1 if replacement else 0)
    assert synthesized not in result.stdout + result.stderr


@pytest.mark.parametrize(
    "kind", ["directory_link", "file_link", "broken_link", "parent_link", "directory", "missing"],
)
def test_secret_scan_fails_closed_on_nonregular_inputs(tmp_path: Path, kind: str) -> None:
    _git(tmp_path, "init", "-q")
    actual = tmp_path / "actual"
    actual.mkdir()
    synthesized = "AKIA" + ("H" * 16)
    (actual / "candidate.txt").write_text(f"service_credential={synthesized}\n")
    target = tmp_path / "input"
    if kind == "directory_link":
        target.symlink_to(actual, target_is_directory=True)
    elif kind == "file_link":
        target.symlink_to(actual / "candidate.txt")
    elif kind == "broken_link":
        target.symlink_to(tmp_path / "absent")
    elif kind == "parent_link":
        target.mkdir()
        (target / "tracked.txt").write_text("safe\n")
        _git(tmp_path, "add", "input/tracked.txt")
        target.rename(tmp_path / "relocated")
        target.symlink_to(tmp_path / "relocated", target_is_directory=True)
    else:
        target.write_text("safe\n")
        _git(tmp_path, "add", "input")
        target.unlink()
        if kind == "directory":
            target.mkdir()
            (target / "child.txt").write_text("safe\n")
    result = _run(tmp_path)
    assert result.returncode == 2
    assert result.stdout == ""
    assert result.stderr.strip() == "secret scan requires existing ordinary files without symlinks"
    assert synthesized not in result.stdout + result.stderr


def _historical_source_pins(root: Path) -> tuple[Path, tuple[Path, ...]]:
    names = (
        "apps/web/src/app/api/v2/historical/[...segments]/route.ts",
        "apps/web/src/lib/bff/historical.ts",
        "services/engine/src/stark_trading_os/control/routes/historical.py",
    )
    sources = tuple(root / name for name in names)
    entries = []
    for name, source in zip(names, sources, strict=True):
        source.parent.mkdir(parents=True, exist_ok=True)
        source.write_text(f"// synthetic public source: {name}\n")
        entries.append(f'  "{name}": "{sha256(source.read_bytes()).hexdigest()}",')
    scanner = root / "scripts/scan-forbidden-capabilities.mjs"
    scanner.parent.mkdir(parents=True)
    scanner.write_text("const HISTORICAL_REVIEWED_SOURCES = {\n" + "\n".join(entries) + "\n};\n")
    return scanner, sources


def test_public_source_pins_require_rehashed_exact_sources(tmp_path: Path) -> None:
    _git(tmp_path, "init", "-q")
    _, sources = _historical_source_pins(tmp_path)
    assert _run(tmp_path).returncode == 0
    sources[0].write_text("changed source\n")
    assert _run(tmp_path).returncode == 1


@pytest.mark.parametrize(
    "mutation",
    ["copied_path", "unknown_source", "missing", "oversized", "symlink", "wrong_field"],
)
def test_public_source_pin_allowance_has_exact_scope(tmp_path: Path, mutation: str) -> None:
    _git(tmp_path, "init", "-q")
    scanner, sources = _historical_source_pins(tmp_path)
    if mutation == "copied_path":
        (tmp_path / "copied.mjs").write_bytes(scanner.read_bytes())
    elif mutation == "unknown_source":
        public = tmp_path / "unreviewed.txt"
        public.write_text("synthetic unreviewed public bytes\n")
        scanner.write_text(f'  "unreviewed.txt": "{sha256(public.read_bytes()).hexdigest()}",\n')
    elif mutation == "missing":
        sources[0].unlink()
    elif mutation == "oversized":
        old = sha256(sources[0].read_bytes()).hexdigest()
        sources[0].write_bytes(b"x" * 262145)
        scanner.write_text(scanner.read_text().replace(
            old, sha256(sources[0].read_bytes()).hexdigest(),
        ))
    elif mutation == "symlink":
        sources[0].rename(tmp_path / "relocated.txt")
        sources[0].symlink_to(tmp_path / "relocated.txt")
    else:
        scanner.write_text(scanner.read_text().replace(
            str(sources[0].relative_to(tmp_path)), "credential",
        ))
    result = _run(tmp_path)
    assert result.returncode == (2 if mutation == "symlink" else 1)


@pytest.mark.parametrize("placement", ["source", "same_line"])
def test_valid_source_pin_does_not_hide_other_credentials(tmp_path: Path, placement: str) -> None:
    _git(tmp_path, "init", "-q")
    scanner, sources = _historical_source_pins(tmp_path)
    synthesized = "AKIA" + ("J" * 16)
    if placement == "source":
        old = sha256(sources[0].read_bytes()).hexdigest()
        sources[0].write_text(f'service_credential = "{synthesized}"\n')
        scanner.write_text(scanner.read_text().replace(
            old, sha256(sources[0].read_bytes()).hexdigest(),
        ))
    else:
        scanner.write_text(scanner.read_text().replace(
            '",\n', f'", service_credential: "{synthesized}",\n', 1,
        ))
    result = _run(tmp_path)
    assert result.returncode == 1
    assert synthesized not in result.stdout + result.stderr


def _t2_manifest(root: Path) -> tuple[Path, Path]:
    directory = root / "services/engine/tests/fixtures/data-model-ports-t2"
    directory.mkdir(parents=True)
    files = []
    for name in ("btcusdt-exchange-info.v1.json", "simulation-assumptions.v1.json"):
        payload = json.dumps({"purpose": "OFFLINE_FIXTURE", "fixture": name}).encode()
        (directory / name).write_bytes(payload)
        files.append({"path": name, "sha256": sha256(payload).hexdigest()})
    manifest = directory / "manifest.v1.json"
    manifest.write_text(json.dumps({
        "schema": "DataModelPortsT2Fixture.v1", "purpose": "OFFLINE_FIXTURE",
        "source": (
            "Human-authored synthetic test data; not an exchange response or product default."
        ),
        "files": files,
    }, indent=2) + "\n")
    return directory, manifest


def test_t2_manifest_hashes_require_matching_fixture_bytes(tmp_path: Path) -> None:
    _git(tmp_path, "init", "-q")
    directory, _ = _t2_manifest(tmp_path)
    assert _run(tmp_path).returncode == 0
    (directory / "btcusdt-exchange-info.v1.json").write_text('{"changed": true}\n')
    assert _run(tmp_path).returncode == 1


@pytest.mark.parametrize(
    "mutation",
    ["copied_path", "wrong_field", "traversal", "duplicate_key", "duplicate_file",
     "extra_file", "wrong_purpose", "wrong_schema", "extra_field", "missing", "symlink"],
)
def test_t2_digest_allowance_is_path_and_schema_bound(tmp_path: Path, mutation: str) -> None:
    _git(tmp_path, "init", "-q")
    directory, manifest = _t2_manifest(tmp_path)
    value = json.loads(manifest.read_text())
    if mutation == "copied_path":
        (tmp_path / "copied.json").write_bytes(manifest.read_bytes())
    elif mutation == "duplicate_key":
        manifest.write_text(manifest.read_text().replace(
            '"purpose":', '"purpose": "OTHER", "purpose":', 1,
        ))
    elif mutation in {"missing", "symlink"}:
        source = directory / "btcusdt-exchange-info.v1.json"
        if mutation == "missing":
            source.unlink()
        else:
            source.rename(tmp_path / "relocated.json")
            source.symlink_to(tmp_path / "relocated.json")
    else:
        if mutation == "wrong_field":
            value["files"][0]["credential"] = value["files"][0].pop("sha256")
        elif mutation == "traversal":
            value["files"][0]["path"] = "../btcusdt-exchange-info.v1.json"
        elif mutation == "duplicate_file":
            value["files"][1] = value["files"][0]
        elif mutation == "extra_file":
            value["files"].append(value["files"][0])
        elif mutation == "wrong_purpose":
            value["purpose"] = "EXTERNAL_OBSERVATION"
        elif mutation == "wrong_schema":
            value["schema"] = "DataModelPortsT2Fixture.v2"
        else:
            value["unreviewed"] = True
        manifest.write_text(json.dumps(value, indent=2))
    result = _run(tmp_path)
    assert result.returncode == (2 if mutation == "symlink" else 1)


@pytest.mark.parametrize("placement", ["fixture", "manifest_line"])
def test_t2_public_digest_does_not_hide_credentials(tmp_path: Path, placement: str) -> None:
    _git(tmp_path, "init", "-q")
    directory, manifest = _t2_manifest(tmp_path)
    synthesized = "AKIA" + ("K" * 16)
    value = json.loads(manifest.read_text())
    if placement == "fixture":
        source = directory / "btcusdt-exchange-info.v1.json"
        source.write_text(f'service_credential="{synthesized}"\n')
        value["files"][0]["sha256"] = sha256(source.read_bytes()).hexdigest()
        manifest.write_text(json.dumps(value, indent=2))
    else:
        manifest.write_text(manifest.read_text().replace(
            '"sha256":', f'"service_credential": "{synthesized}", "sha256":', 1,
        ))
    result = _run(tmp_path)
    assert result.returncode == 1
    assert synthesized not in result.stdout + result.stderr


def _t3_manifest(root: Path) -> tuple[Path, Path, Path]:
    directory = root / "services/engine/tests/fixtures/data-model-ports-t3"
    directory.mkdir(parents=True)
    evidence = "Synthetic BTC public observation"
    value = {
        "schema": "T3_SYNTHETIC_SCENARIOS_V1", "purpose": "OFFLINE_FIXTURE",
        "request": {
            "task": {"evidence": [{"evidence_id": "fixture-evidence-1", "text": evidence}]},
            "bindings": [{"evidence_id": "fixture-evidence-1",
                          "utf8_sha256": sha256(evidence.encode()).hexdigest()}],
            "policy": {
                "renderer_revision": "FIXTURE_REQUEST_V1",
                "system_sha256": sha256(b"fixture-system").hexdigest(),
                "schema_sha256": sha256(b"fixture-schema").hexdigest(),
            },
        },
    }
    source = directory / "scenarios.v1.json"
    source.write_text(json.dumps(value, indent=2) + "\n")
    manifest = directory / "manifest.v1.json"
    manifest.write_text(json.dumps({
        "schema": "T3_FIXTURE_MANIFEST_V1", "purpose": "OFFLINE_FIXTURE",
        "source": "synthetic-only-no-provider-prices",
        "files": [{"name": source.name, "sha256": sha256(source.read_bytes()).hexdigest()}],
    }, indent=2) + "\n")
    return directory, manifest, source


def _rehash_t3(manifest: Path, source: Path) -> None:
    value = json.loads(manifest.read_text())
    value["files"][0]["sha256"] = sha256(source.read_bytes()).hexdigest()
    manifest.write_text(json.dumps(value, indent=2) + "\n")


def test_t3_content_digests_are_recomputed_in_their_exact_context(tmp_path: Path) -> None:
    _git(tmp_path, "init", "-q")
    _, manifest, source = _t3_manifest(tmp_path)
    assert _run(tmp_path).returncode == 0
    source.write_text(source.read_text().replace("BTC public", "ETH public"))
    _rehash_t3(manifest, source)
    assert _run(tmp_path).returncode == 1


@pytest.mark.parametrize("mutation", [
    "copied_path", "wrong_field", "duplicate_manifest_key", "duplicate_source_key",
    "traversal", "extra_file", "wrong_purpose", "wrong_schema", "wrong_source_schema",
    "wrong_renderer", "wrong_system", "wrong_evidence_id", "duplicate_evidence",
    "copied_hash_field", "stale_manifest", "missing", "symlink", "oversize",
])
def test_t3_digests_are_not_general_fixture_exemptions(tmp_path: Path, mutation: str) -> None:
    _git(tmp_path, "init", "-q")
    _, manifest, source = _t3_manifest(tmp_path)
    m, s = json.loads(manifest.read_text()), json.loads(source.read_text())
    if mutation == "copied_path":
        (tmp_path / "copied.json").write_bytes(source.read_bytes())
    elif mutation == "duplicate_manifest_key":
        manifest.write_text(manifest.read_text().replace(
            '"purpose":', '"purpose": "OTHER", "purpose":', 1,
        ))
    elif mutation == "duplicate_source_key":
        source.write_text(source.read_text().replace(
            '"purpose":', '"purpose": "OTHER", "purpose":', 1,
        ))
        _rehash_t3(manifest, source)
    elif mutation in {"missing", "symlink"}:
        if mutation == "missing":
            source.unlink()
        else:
            source.rename(tmp_path / "relocated.json")
            source.symlink_to(tmp_path / "relocated.json")
    elif mutation == "oversize":
        source.write_text(source.read_text() + (" " * 262144))
        _rehash_t3(manifest, source)
    elif mutation in {"traversal", "extra_file", "wrong_purpose", "wrong_schema"}:
        if mutation == "traversal":
            m["files"][0]["name"] = "../scenarios.v1.json"
        elif mutation == "extra_file":
            m["files"].append(m["files"][0])
        elif mutation == "wrong_purpose":
            m["purpose"] = "EXTERNAL_OBSERVATION"
        else:
            m["schema"] = "UNREVIEWED"
        manifest.write_text(json.dumps(m, indent=2))
    else:
        if mutation == "wrong_field":
            s["request"]["policy"]["credential"] = s["request"]["policy"].pop("system_sha256")
        elif mutation == "wrong_source_schema":
            s["schema"] = "UNREVIEWED"
        elif mutation == "wrong_renderer":
            s["request"]["policy"]["renderer_revision"] = "UNREVIEWED"
        elif mutation == "wrong_system":
            s["request"]["policy"]["system_sha256"] = sha256(b"different").hexdigest()
        elif mutation == "wrong_evidence_id":
            s["request"]["bindings"][0]["evidence_id"] = "other"
        elif mutation == "duplicate_evidence":
            s["request"]["task"]["evidence"].append(s["request"]["task"]["evidence"][0])
        elif mutation == "copied_hash_field":
            s["elsewhere"] = {"system_sha256": s["request"]["policy"]["system_sha256"]}
        elif mutation == "stale_manifest":
            s["changed"] = True
        source.write_text(json.dumps(s, indent=2) + "\n")
        if mutation != "stale_manifest":
            _rehash_t3(manifest, source)
    result = _run(tmp_path)
    assert result.returncode == (2 if mutation == "symlink" else 1)


@pytest.mark.parametrize("placement", ["text", "same_line"])
def test_t3_rehashed_content_still_scans_for_credentials(tmp_path: Path, placement: str) -> None:
    _git(tmp_path, "init", "-q")
    _, manifest, source = _t3_manifest(tmp_path)
    synthesized = "AKIA" + ("L" * 16)
    s = json.loads(source.read_text())
    if placement == "text":
        s["request"]["task"]["evidence"][0]["text"] = synthesized
        s["request"]["bindings"][0]["utf8_sha256"] = sha256(synthesized.encode()).hexdigest()
        source.write_text(json.dumps(s, indent=2) + "\n")
    else:
        source.write_text(source.read_text().replace(
            '"system_sha256":', f'"credential": "{synthesized}", "system_sha256":', 1,
        ))
    _rehash_t3(manifest, source)
    result = _run(tmp_path)
    assert result.returncode == 1
    assert synthesized not in result.stdout + result.stderr


@pytest.mark.parametrize("encoding", ["value", "key", "inline"])
def test_t3_json_spelling_cannot_move_a_digest_to_another_subtree(
    tmp_path: Path, encoding: str,
) -> None:
    _git(tmp_path, "init", "-q")
    _, manifest, source = _t3_manifest(tmp_path)
    value = json.loads(source.read_text())
    digest = value["request"]["policy"]["system_sha256"]
    value["elsewhere"] = {"system_sha256": digest}
    raw = json.dumps(value, indent=2) + "\n"
    original = f'"system_sha256": "{digest}"'
    if encoding == "value":
        escaped = "".join(f"\\u{ord(char):04x}" for char in digest)
        replacement = f'"system_sha256": "{escaped}"'
    elif encoding == "key":
        replacement = f'"\\u0073ystem_sha256": "{digest}"'
    else:
        replacement = original + ', "synthetic_extra": true'
    source.write_text(raw.replace(original, replacement, 1))
    _rehash_t3(manifest, source)
    result = _run(tmp_path)
    assert result.returncode == 1
    assert digest not in result.stdout + result.stderr


REVIEWED_LITERAL_PATHS = (
    'services/engine/src/stark_trading_os/control/postgres/access.py',
    'services/engine/src/stark_trading_os/control/postgres/public_access.py',
    'services/engine/src/stark_trading_os/control/postgres/research_access.py',
    'services/engine/src/stark_trading_os/control/postgres/synthetic_migration.py',
    'services/engine/src/stark_trading_os/domain/strategy_contracts.py',
    'services/engine/tests/fixtures/q01_c_registry_v1.json',
    'services/engine/tests/fixtures/q08_a1_btc_v1.json',
    'services/engine/tests/integration/control/test_public_live.py',
    'services/engine/tests/integration/control/test_public_pg.py',
    'services/engine/tests/integration/control/test_public_provider_wiring.py',
    'services/engine/tests/unit/control/test_public_data_collection.py',
    'services/engine/tests/unit/control/test_public_live_config.py',
    'services/engine/tests/unit/control/test_s03_schema9_migration.py',
    'services/engine/tests/unit/domain/test_opportunity_recommendations.py',
)


def _reviewed_literal_fixture(root: Path) -> None:
    _git(root, "init", "-q")
    for relative in REVIEWED_LITERAL_PATHS:
        target = root / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes((REPOSITORY_ROOT / relative).read_bytes())


def test_reviewed_public_literal_slots_pass_without_exempting_files(tmp_path: Path) -> None:
    _reviewed_literal_fixture(tmp_path)
    result = _run(tmp_path)
    assert result.returncode == 0, result.stderr


@pytest.mark.parametrize("mutation", [
    "digest_value", "wrong_field", "copied_path", "same_line", "other_line", "json_duplicate",
])
def test_reviewed_literal_allowance_is_value_field_and_source_bound(
    tmp_path: Path, mutation: str,
) -> None:
    _reviewed_literal_fixture(tmp_path)
    relative = "services/engine/src/stark_trading_os/control/postgres/synthetic_migration.py"
    path = tmp_path / relative
    text = path.read_text()
    synthesized = "AKIA" + "M" * 16
    if mutation == "digest_value":
        line = next(line for line in text.splitlines() if line.startswith("CATALOG_SHA256 ="))
        replacement = 'CATALOG_SHA256 = "' + sha256(b"unreviewed pin").hexdigest() + '"'
        text = text.replace(line, replacement)
    elif mutation == "wrong_field":
        text = text.replace("CATALOG_SHA256 =", "credential =", 1)
    elif mutation == "copied_path":
        (tmp_path / "copied.py").write_text(text)
    elif mutation == "same_line":
        line = next(line for line in text.splitlines() if line.startswith("CATALOG_SHA256 ="))
        text = text.replace(line, line + f'; service_credential = "{synthesized}"')
    elif mutation == "other_line":
        text += f'\nservice_credential = "{synthesized}"\n'
    else:
        fixture = tmp_path / "services/engine/tests/fixtures/q08_a1_btc_v1.json"
        fixture.write_text(fixture.read_text().replace('"plan": {', '"plan": {}, "plan": {', 1))
    if mutation not in {"copied_path", "json_duplicate"}:
        path.write_text(text)
    result = _run(tmp_path)
    assert result.returncode == 1
    assert synthesized not in result.stdout + result.stderr


OPTIONAL_SOURCE_PATHS = (
    "services/engine/src/stark_trading_os/control/routes/assistant_tools.py",
    "services/engine/src/stark_trading_os/control/routes/public_data.py",
    "services/engine/src/stark_trading_os/control/routes/recommendations.py",
    "services/engine/src/stark_trading_os/control/routes/strategy_references.py",
    "services/engine/src/stark_trading_os/control/app.py",
    "services/engine/src/stark_trading_os/control/security.py",
    "services/engine/src/stark_trading_os/control/postgres/caller.py",
    "services/engine/src/stark_trading_os/control/postgres/identity.py",
)


@pytest.mark.parametrize("relative", OPTIONAL_SOURCE_PATHS)
def test_optional_source_pins_rehash_actual_exact_sources(tmp_path: Path, relative: str) -> None:
    _git(tmp_path, "init", "-q")
    source = tmp_path / relative
    source.parent.mkdir(parents=True)
    source.write_text("# synthetic bounded public source\n")
    scanner = tmp_path / "scripts/scan-forbidden-capabilities.mjs"
    scanner.parent.mkdir(parents=True)
    scanner.write_text(f'  "{relative}": "{sha256(source.read_bytes()).hexdigest()}",\n')
    assert _run(tmp_path).returncode == 0
    source.write_text("# altered source\n")
    assert _run(tmp_path).returncode == 1


@pytest.mark.parametrize("mutation", [
    "changed_source", "updated_source_hash", "unknown_source", "wrong_field",
    "copied_path", "same_line", "other_line", "wrong_slot",
])
def test_reviewed_literal_source_pins_require_fixed_values_and_actual_bytes(
    tmp_path: Path, mutation: str,
) -> None:
    _reviewed_literal_fixture(tmp_path)
    relative = REVIEWED_LITERAL_PATHS[0]
    source = tmp_path / relative
    digest = sha256(source.read_bytes()).hexdigest()
    declaration = tmp_path / "services/engine/scripts/scan_secrets.py"
    declaration.parent.mkdir(parents=True, exist_ok=True)
    entry = f'    "{relative}": "{digest}",'
    text = "_REVIEWED_LITERAL_SOURCE_SHA256: dict[str, str] = {\n" + entry + "\n}\n"
    declaration.write_text(text)
    assert _run(tmp_path).returncode == 0

    synthesized = "AKIA" + "N" * 16
    if mutation in {"changed_source", "updated_source_hash"}:
        source.write_text(source.read_text() + "\n# changed public source\n")
        if mutation == "updated_source_hash":
            text = text.replace(digest, sha256(source.read_bytes()).hexdigest())
    elif mutation == "unknown_source":
        public = tmp_path / "unreviewed.py"
        public.write_text("# unreviewed public source\n")
        text = text.replace(relative, "unreviewed.py").replace(
            digest, sha256(public.read_bytes()).hexdigest(),
        )
    elif mutation == "wrong_field":
        text = text.replace("_REVIEWED_LITERAL_SOURCE_SHA256", "credential")
    elif mutation == "copied_path":
        (tmp_path / "copied.py").write_text(text)
    elif mutation == "same_line":
        text = text.replace(entry, entry + f'  # service_credential="{synthesized}"')
    elif mutation == "other_line":
        text += f'service_credential = "{synthesized}"\n'
    else:
        text = f'_REVIEWED_LITERAL_SOURCE_SHA256: str = "{digest}"\n'
    declaration.write_text(text)
    result = _run(tmp_path)
    assert result.returncode == 1
    assert "secret scan failed" in result.stderr
    if mutation in {"changed_source", "updated_source_hash"}:
        # Both original constants and the declaration's digest must be rejected.
        assert "3 candidate(s)" in result.stderr
    assert digest not in result.stdout + result.stderr
    assert synthesized not in result.stdout + result.stderr
