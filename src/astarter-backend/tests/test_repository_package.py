"""Current product packaging preserves all claimed source and distribution bytes."""
import hashlib
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SUPPORT = {
    'public': {
        '.gitignore', '.python-version', '.vercelignore', 'README.md', 'app.py',
        'cloud.py', 'cloud_preview.py', 'cloud_transport.py', 'pyproject.toml',
        'requirements.txt', 'source-manifest.json', 'uv.lock', 'vercel.json',
        'tests/test_cloud.py', 'tests/test_live.py', 'tests/test_live_resources.py',
        'tests/test_preview.py',
    },
    'private': {
        '.gitignore', '.python-version', 'README.md', 'app.py', 'requirements.txt',
        'source-manifest.json', 'vercel.json', 'tests/test_entrypoint.py',
        'tests/test_platform_catalog.py',
    },
}


def checked_file(root, relative):
    path = Path(relative)
    assert not path.is_absolute() and '..' not in path.parts
    result = root / path
    assert result.is_file() and result.resolve() == result
    return result


def test_core_source_and_distribution_closures_are_complete():
    index = json.loads((ROOT / 'source-index.json').read_text())
    assert index['schema'] == 'AstarterCurrentRepository.v1'
    assert index['core']['original_source_file_count'] == 463
    assert len(index['core']['files']) == 465
    for name, digest in index['core']['files'].items():
        assert hashlib.sha256(checked_file(ROOT, name).read_bytes()).hexdigest() == digest
    for kind, expected_count in [('public', 39), ('private', 49)]:
        directory = ROOT / 'deployments' / kind
        raw = (directory / 'source-manifest.json').read_bytes()
        assert (
            hashlib.sha256(raw).hexdigest()
            == index['distributions'][kind]['source_manifest_sha256']
        )
        sources = json.loads(raw)['files']
        assert len(sources) == expected_count
        package = index['distributions'][kind]['package_files']
        assert set(package) == set(sources) | SUPPORT[kind]
        assert len(package) == index['distributions'][kind]['package_file_count']
        differences = []
        for name, digest in package.items():
            assert hashlib.sha256(checked_file(directory, name).read_bytes()).hexdigest() == digest
        for name, digest in sources.items():
            expected = digest if isinstance(digest, str) else digest['sha256']
            assert (
                hashlib.sha256(checked_file(directory, name).read_bytes()).hexdigest() == expected
            )
            if index['core']['files']['services/engine/src/' + name] != expected:
                differences.append(name)
        assert sorted(differences) == sorted(
            index['distributions'][kind]['shared_files_different_from_core']
        )


def test_shared_contract_and_current_entries():
    fixture = ROOT / 'contracts/astarter/private-draft-fixtures.json'
    assert hashlib.sha256(fixture.read_bytes()).hexdigest() == (
        'b682a71bdcb41635db6002441300010b8e44bdc1ae3dc407abc266f9384def03'
    )
    for legacy in ['apps', '.goodway', '.superpowers', 'pnpm-workspace.yaml']:
        assert not (ROOT / legacy).exists()
    for name in ['README.md', 'README.en.md']:
        text = (ROOT / name).read_text()
        assert text.count('```') % 2 == 0
        for link in re.findall(r'\]\(([^)]+)\)', text):
            if not link.startswith(('https://', 'http://', '#')):
                checked_file(ROOT, link.split('#')[0])
