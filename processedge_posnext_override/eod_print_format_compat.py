"""Narrow POSNext v1.17 EOD print-format compatibility for Frappe v16.

The vendor's EOD Jinja reads POS Profile.address, which is not a field on
Frappe/ERPNext's supported POS Profile. That SELECT fails even when the POS
Closing Shift is already submitted. Only the exact known expression is
replaced; the accounting totals, layout and document identity are preserved.

This migration-time repair deliberately does not modify POSNext core, create
a custom POS Profile field, or alter a closed shift.
"""

from __future__ import annotations

PRINT_FORMAT_NAME = "POS Next EOD Report"
BROKEN_PROFILE_ADDRESS_LINE = (
    "{%- set profile_address = frappe.db.get_value('POS Profile', doc.pos_profile, 'address') -%}"
)
FALLBACK_PROFILE_ADDRESS_LINE = "{%- set profile_address = '' -%}"


def repair_eod_print_html(html: str) -> str:
    """Remove only the single known vendor expression, preserving all other HTML.

    Different/customized templates are left untouched for explicit review.
    """
    if not isinstance(html, str) or html.count(BROKEN_PROFILE_ADDRESS_LINE) != 1:
        return html
    return html.replace(BROKEN_PROFILE_ADDRESS_LINE, FALLBACK_PROFILE_ADDRESS_LINE, 1)


def ensure_eod_print_format_compat() -> bool:
    """Repair the vendor print format only when POS Profile.address is absent.

    Runs from after_migrate, after POSNext's standard documents have loaded.
    Idempotent and transaction-safe; callers should not commit independently.
    """
    import frappe

    if not frappe.db.exists("Print Format", PRINT_FORMAT_NAME):
        return False
    if frappe.db.has_column("POS Profile", "address"):
        return False

    print_format = frappe.get_doc("Print Format", PRINT_FORMAT_NAME)
    previous_html = print_format.html or ""
    corrected_html = repair_eod_print_html(previous_html)
    if corrected_html == previous_html:
        return False

    print_format.html = corrected_html
    print_format.save(ignore_permissions=True)
    frappe.clear_document_cache("Print Format", PRINT_FORMAT_NAME)
    return True
