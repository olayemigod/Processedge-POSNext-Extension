"""Protect unsent saved sales from POSNext's optional shift-close draft cleanup.

POSNext v1.17.0's POS Closing Shift.on_submit() calls
delete_draft_invoices(); if POS Profile.posa_allow_delete is enabled, that
routine force-deletes unprinted Sales Invoice drafts tied to the opening shift.
The native setting remains authoritative. Rather than give cashiers blanket
Delete permission or silently remove saved work, fail before submission when
the native cleanup would find an eligible unprinted draft.
"""

from __future__ import annotations

import frappe
from frappe import _
from frappe.utils import cint


def prevent_unprinted_draft_deletion_on_close(doc, method=None):
    """Stop a shift close that would delete unprinted, saved Sales Invoices."""
    if getattr(doc, "doctype", None) != "POS Closing Shift":
        return

    opening_shift = str(getattr(doc, "pos_opening_shift", "") or "").strip()
    pos_profile = str(getattr(doc, "pos_profile", "") or "").strip()
    if not opening_shift or not pos_profile:
        # Missing parent context remains for native POSNext validation to reject.
        return

    if not cint(frappe.db.get_value("POS Profile", pos_profile, "posa_allow_delete")):
        # POSNext won't delete drafts when this native option is disabled.
        return

    # Match POSNext v1.17.0's exact deletion filters without selecting invoice
    # contents or modifying any saved Sales Invoice.
    pending = frappe.db.exists(
        "Sales Invoice",
        {
            "docstatus": 0,
            "posa_is_printed": 0,
            "posa_pos_opening_shift": opening_shift,
        },
    )
    if pending:
        frappe.throw(
            _(
                "This shift has unprinted saved sales. Complete those sales, or "
                "ask a manager to disable automatic draft deletion in the POS "
                "Profile before closing the shift. The saved sales are unchanged."
            )
        )
