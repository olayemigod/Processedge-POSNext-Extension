from __future__ import annotations

import json
import tomllib
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


def test_release_metadata_is_consistent():
    pyproject = tomllib.loads((ROOT / "pyproject.toml").read_text(encoding="utf-8"))
    init_text = (ROOT / "processedge_posnext_override" / "__init__.py").read_text(encoding="utf-8")
    setup_text = (ROOT / "setup.py").read_text(encoding="utf-8")

    project_version = pyproject["project"]["version"]
    init_version = next(
        (
            line.split("=", 1)[1].strip().strip("'\\\"")
            for line in init_text.splitlines()
            if line.strip().startswith("__version__ =")
        ),
        None,
    )
    setup_version = next(
        (
            line.split("=", 1)[1].strip().rstrip(",").strip("'\\\"")
            for line in setup_text.splitlines()
            if line.strip().startswith("version=")
        ),
        None,
    )

    assert init_version, "processedge_posnext_override/__init__.py must declare __version__"
    assert setup_version, "setup.py must declare version"
    assert project_version == init_version == setup_version


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
