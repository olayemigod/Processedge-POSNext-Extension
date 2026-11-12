"""Regression checks for POSNext v1.17's EOD print format on Frappe v16.

POSNext's shipped Jinja reads POS Profile.address, a field not present on
supported POS Profile metadata. A printview must not fail with SQL 1054.
This is scoped strictly to the vendor's EOD format and preserves financial
figures and all other markup.
"""

from __future__ import annotations

import sys
from types import ModuleType, SimpleNamespace
from unittest.mock import Mock, patch

from processedge_posnext_override.eod_print_format_compat import (
    BROKEN_PROFILE_ADDRESS_LINE,
    FALLBACK_PROFILE_ADDRESS_LINE,
    PRINT_FORMAT_NAME,
    repair_eod_print_html,
    ensure_eod_print_format_compat,
)


def test_vendor_eod_template_removes_only_missing_profile_address_read():
    original = (
        "<h1>END-OF-DAY REPORT</h1>\n"
        + BROKEN_PROFILE_ADDRESS_LINE
        + "\n{% if profile_address %}{{ profile_address }}{% endif %}\n"
        + "{{ doc.grand_total }} | {{ doc.payment_reconciliation }}\n"
    )
    repaired = repair_eod_print_html(original)
    assert BROKEN_PROFILE_ADDRESS_LINE not in repaired
    assert FALLBACK_PROFILE_ADDRESS_LINE in repaired
    assert "doc.grand_total" in repaired
    assert "doc.payment_reconciliation" in repaired
    assert repair_eod_print_html(repaired) == repaired


def test_unknown_print_formats_remain_untouched():
    custom = "<p>Custom EOD {{ doc.name }}</p>"
    assert repair_eod_print_html(custom) == custom
    assert repair_eod_print_html("") == ""
    # Never guess replacements for a duplicate or altered source template.
    assert repair_eod_print_html(BROKEN_PROFILE_ADDRESS_LINE * 2) == BROKEN_PROFILE_ADDRESS_LINE * 2


def test_migrate_repairs_only_known_print_format_without_profile_address_column():
    doc = SimpleNamespace(html=BROKEN_PROFILE_ADDRESS_LINE, save=Mock())
    db = SimpleNamespace(
        exists=Mock(return_value=True),
        has_column=Mock(return_value=False),
    )
    frappe = ModuleType("frappe")
    frappe.db = db
    frappe.get_doc = Mock(return_value=doc)
    frappe.clear_document_cache = Mock()
    with patch.dict(sys.modules, {"frappe": frappe}):
        assert ensure_eod_print_format_compat() is True
        assert ensure_eod_print_format_compat() is False
    db.exists.assert_any_call("Print Format", PRINT_FORMAT_NAME)
    db.has_column.assert_called_with("POS Profile", "address")
    frappe.get_doc.assert_called_with("Print Format", PRINT_FORMAT_NAME)
    doc.save.assert_called_once_with(ignore_permissions=True)
    frappe.clear_document_cache.assert_called_once_with("Print Format", PRINT_FORMAT_NAME)


def test_migrate_preserves_supported_profile_address_and_missing_format():
    for installed, has_address, expected in (
        (False, False, False),
        (True, True, False),
    ):
        frappe = ModuleType("frappe")
        frappe.db = SimpleNamespace(
            exists=Mock(return_value=installed),
            has_column=Mock(return_value=has_address),
        )
        frappe.get_doc = Mock(side_effect=AssertionError("should not edit print format"))
        with patch.dict(sys.modules, {"frappe": frappe}):
            assert ensure_eod_print_format_compat() is expected
        frappe.get_doc.assert_not_called()
