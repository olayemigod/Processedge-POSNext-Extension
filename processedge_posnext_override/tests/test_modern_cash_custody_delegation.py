"""Executable contract for the POSNext closing override's modern RetailEdge handoff.

This test loads the real override with isolated framework adapters rather than
merely searching source text. It requires no site, database or accounting writes.
Site-level reconciliation acceptance is a separate release gate.
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path
from types import ModuleType, SimpleNamespace
from unittest.mock import Mock, patch

SOURCE = Path(__file__).resolve().parents[1] / "overrides" / "closing_shift.py"


def _load_closing_override(*, modern: bool):
    frappe = ModuleType("frappe")
    frappe.get_installed_apps = lambda: ["retailedge"] if modern else []
    frappe.get_attr = lambda name: object() if modern else None
    frappe.whitelist = lambda *args, **kwargs: lambda fn: fn
    frappe.db = SimpleNamespace()

    utils = ModuleType("frappe.utils")
    utils.flt = float
    frappe.utils = utils

    pos_next = ModuleType("pos_next")
    api = ModuleType("pos_next.api")
    shifts = ModuleType("pos_next.api.shifts")
    native_closing = Mock(
        side_effect=lambda opening_shift: {
            "pos_opening_shift": opening_shift,
            "payment_reconciliation": [
                {"mode_of_payment": "Cash", "expected_amount": 13000}
            ],
        }
    )
    shifts.get_closing_shift_data = native_closing

    retailedge = ModuleType("retailedge")
    retail_bridge = ModuleType("retailedge.pos_cashier_expense")
    adjust = Mock(
        side_effect=lambda closing_data, *, opening_shift: {
            **closing_data,
            "payment_reconciliation": [
                {"mode_of_payment": "Cash", "expected_amount": 10000}
            ],
            "retailedge_cashier_expense_total": 1000,
            "retailedge_cash_deposit_total": 2000,
            "adjusted_shift": opening_shift,
        }
    )
    retail_bridge.apply_retailedge_cashier_expenses_to_closing_data = adjust

    modules = {
        "frappe": frappe,
        "frappe.utils": utils,
        "pos_next": pos_next,
        "pos_next.api": api,
        "pos_next.api.shifts": shifts,
        "retailedge": retailedge,
        "retailedge.pos_cashier_expense": retail_bridge,
    }
    with patch.dict(sys.modules, modules):
        spec = importlib.util.spec_from_file_location(
            "_processedge_closing_shift_contract", SOURCE
        )
        override = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(override)
    return override, native_closing, adjust, modules


def test_modern_closing_delegates_once_to_retailedge_without_legacy_deductions():
    override, native, modern_adjust, modules = _load_closing_override(modern=True)
    legacy = Mock(side_effect=AssertionError("legacy bridge must not run"))

    with patch.dict(sys.modules, modules), patch.object(
        override, "apply_legacy_retailedge_expenses", legacy
    ):
        result = override.get_closing_shift_data("OPEN-TEST-001")

    native.assert_called_once_with("OPEN-TEST-001")
    modern_adjust.assert_called_once()
    original_data = modern_adjust.call_args.args[0]
    assert original_data["payment_reconciliation"][0]["expected_amount"] == 13000
    assert modern_adjust.call_args.kwargs == {"opening_shift": "OPEN-TEST-001"}
    legacy.assert_not_called()
    assert result["payment_reconciliation"][0]["expected_amount"] == 10000
    assert result["retailedge_cashier_expense_total"] == 1000
    assert result["retailedge_cash_deposit_total"] == 2000
    assert result["adjusted_shift"] == "OPEN-TEST-001"


def test_legacy_fallback_remains_available_when_modern_app_is_not_installed():
    override, native, modern_adjust, modules = _load_closing_override(modern=False)
    legacy = Mock(
        side_effect=lambda data, opening_shift: {
            **data,
            "legacy_shift": opening_shift,
        }
    )

    with patch.dict(sys.modules, modules), patch.object(
        override, "apply_legacy_retailedge_expenses", legacy
    ):
        result = override.get_closing_shift_data("OPEN-LEGACY-001")

    native.assert_called_once_with("OPEN-LEGACY-001")
    modern_adjust.assert_not_called()
    legacy.assert_called_once()
    assert legacy.call_args.args[1] == "OPEN-LEGACY-001"
    assert result["legacy_shift"] == "OPEN-LEGACY-001"


def test_modern_adjustment_error_is_not_silently_replaced_by_legacy_numbers():
    override, native, modern_adjust, modules = _load_closing_override(modern=True)
    modern_adjust.side_effect = ValueError("shift cash cannot be verified")
    legacy = Mock(side_effect=AssertionError("must fail closed"))

    with patch.dict(sys.modules, modules), patch.object(
        override, "apply_legacy_retailedge_expenses", legacy
    ):
        try:
            override.get_closing_shift_data("OPEN-UNVERIFIED-001")
        except ValueError as error:
            assert "cannot be verified" in str(error)
        else:
            raise AssertionError("An unverified closing must fail closed.")

    native.assert_called_once_with("OPEN-UNVERIFIED-001")
    modern_adjust.assert_called_once()
    legacy.assert_not_called()
