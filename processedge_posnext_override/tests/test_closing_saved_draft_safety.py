"""Executable no-site tests for protecting saved sales at POSNext shift close."""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path
from types import ModuleType, SimpleNamespace
from unittest.mock import Mock, patch

SOURCE = Path(__file__).resolve().parents[1] / "overrides" / "closing_draft_safety.py"
HOOKS = (Path(__file__).resolve().parents[1] / "hooks.py").read_text(encoding="utf-8")


def _load():
    frappe = ModuleType("frappe")
    frappe._ = lambda value: value
    frappe.throw = Mock(side_effect=lambda message: (_ for _ in ()).throw(ValueError(message)))
    frappe.db = SimpleNamespace(
        get_value=Mock(return_value=1),
        exists=Mock(return_value="SINV-SAVED-001"),
    )
    utils = ModuleType("frappe.utils")
    utils.cint = lambda value: int(value or 0)
    frappe.utils = utils
    with patch.dict(sys.modules, {"frappe": frappe, "frappe.utils": utils}):
        spec = importlib.util.spec_from_file_location(
            "_closing_draft_safety_contract", SOURCE
        )
        override = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(override)
    return override, frappe


def _closing():
    return SimpleNamespace(
        doctype="POS Closing Shift",
        pos_opening_shift="POSA-OPEN-001",
        pos_profile="POS-001",
    )


def test_guard_is_registered_before_native_pos_closing_submit():
    assert '"POS Closing Shift": {' in HOOKS
    assert '"before_submit": "processedge_posnext_override.overrides.closing_draft_safety.prevent_unprinted_draft_deletion_on_close"' in HOOKS


def test_unprinted_draft_with_native_delete_enabled_fails_before_close():
    guard, frappe = _load()
    try:
        guard.prevent_unprinted_draft_deletion_on_close(_closing())
    except ValueError as error:
        assert "unprinted saved sales" in str(error)
        assert "disable automatic draft deletion" in str(error)
    else:
        raise AssertionError("A close that deletes saved sales must not proceed.")

    frappe.db.get_value.assert_called_once_with("POS Profile", "POS-001", "posa_allow_delete")
    frappe.db.exists.assert_called_once_with(
        "Sales Invoice",
        {
            "docstatus": 0,
            "posa_is_printed": 0,
            "posa_pos_opening_shift": "POSA-OPEN-001",
        },
    )
    frappe.throw.assert_called_once()


def test_native_delete_disabled_preserves_drafts_and_allows_close():
    guard, frappe = _load()
    frappe.db.get_value.return_value = 0
    assert guard.prevent_unprinted_draft_deletion_on_close(_closing()) is None
    frappe.db.exists.assert_not_called()
    frappe.throw.assert_not_called()


def test_native_delete_enabled_with_no_matching_drafts_allows_close():
    guard, frappe = _load()
    frappe.db.exists.return_value = None
    assert guard.prevent_unprinted_draft_deletion_on_close(_closing()) is None
    frappe.db.exists.assert_called_once()
    frappe.throw.assert_not_called()


def test_other_doctype_and_missing_context_do_not_inspect_sales():
    guard, frappe = _load()
    assert guard.prevent_unprinted_draft_deletion_on_close(
        SimpleNamespace(doctype="Sales Invoice", pos_profile="POS-001", pos_opening_shift="POSA-OPEN-001")
    ) is None
    assert guard.prevent_unprinted_draft_deletion_on_close(
        SimpleNamespace(doctype="POS Closing Shift", pos_profile="POS-001", pos_opening_shift="")
    ) is None
    frappe.db.get_value.assert_not_called()
    frappe.db.exists.assert_not_called()


def test_unresolvable_saved_draft_read_fails_closed():
    guard, frappe = _load()
    frappe.db.exists.side_effect = RuntimeError("SQL lookup failed")
    try:
        guard.prevent_unprinted_draft_deletion_on_close(_closing())
    except RuntimeError as error:
        assert "SQL lookup failed" in str(error)
    else:
        raise AssertionError("A failed saved-draft lookup must not authorise deletion.")
