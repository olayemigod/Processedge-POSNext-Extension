from __future__ import annotations

import json
import re
import tomllib
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


def test_release_metadata_is_consistent():
    pyproject = tomllib.loads((ROOT / "pyproject.toml").read_text(encoding="utf-8"))
    init_text = (ROOT / "processedge_posnext_override" / "__init__.py").read_text(encoding="utf-8")
    setup_text = (ROOT / "setup.py").read_text(encoding="utf-8")

    project_version = pyproject["project"]["version"]
    init_match = re.search(r'__version__\\s*=\\s*["\\\']([^"\\\']+)["\\\']', init_text)
    setup_match = re.search(r'version\\s*=\\s*["\\\']([^"\\\']+)["\\\']', setup_text)

    assert init_match, "processedge_posnext_override/__init__.py must declare __version__"
    assert setup_match, "setup.py must declare version"
    assert project_version == init_match.group(1) == setup_match.group(1)


def test_frappe_v16_dependency_contract():
    pyproject = tomllib.loads((ROOT / "pyproject.toml").read_text(encoding="utf-8"))
    assert pyproject["tool"]["bench"]["frappe-dependencies"]["frappe"] == ">=16.0.0-dev,<17.0.0"


def test_canonical_repository_url_is_documented():
    readme = (ROOT / "README.md").read_text(encoding="utf-8")
    assert "https://github.com/olayemigod/Processedge-POSNext-Extension.git" in readme
    assert "Processedge-POSNext-override.git" not in readme


def test_packaged_json_files_are_valid():
    for path in (ROOT / "processedge_posnext_override").rglob("*.json"):
        json.loads(path.read_text(encoding="utf-8"))
