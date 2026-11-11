"""Read-only RC3 integration probe for a disposable Frappe/ERPNext/POSNext site.

Run with:
    bench --site retail-pos-ci.localhost execute \
      processedge_posnext_override.tests.rc3_integrated_site_probe.verify

Unlike the isolated Python mocks, this inspects the real installed Frappe hook
registry, POSNext DocType metadata and app imports. It does not create, submit,
delete, or close any commercial documents.
"""

from __future__ import annotations

import frappe

NATIVE_CLOSING_API = "pos_next.api.shifts.get_closing_shift_data"
RETAIL_CLOSING_API = (
    "retailedge.pos_cashier_expense.get_posnext_closing_shift_data_with_cashier_expenses"
)
EXTENSION_CLOSING_API = (
    "processedge_posnext_override.overrides.closing_shift.get_closing_shift_data"
)
CLOSING_VALIDATE = (
    "retailedge.pos_cashier_expense.apply_retailedge_cashier_expenses_to_closing_shift"
)
DRAFT_GUARD = (
    "processedge_posnext_override.overrides.closing_draft_safety."
    "prevent_unprinted_draft_deletion_on_close"
)


def _handlers(doc_events, event):
    registered = doc_events.get("POS Closing Shift", {}).get(event, [])
    if isinstance(registered, str):
        return [registered]
    return list(registered or [])


def verify():
    required_apps = {
        "frappe",
        "erpnext",
        "payments",
        "edgesuite_ui",
        "pos_next",
        "retailedge",
        "processedge_posnext_override",
    }
    installed = set(frappe.get_installed_apps())
    assert required_apps.issubset(installed), sorted(required_apps - installed)

    meta = frappe.get_meta("POS Closing Shift")
    for fieldname in (
        "retailedge_cashier_expense_total",
        "retailedge_cash_deposit_total",
        "retailedge_cash_deposit_count",
    ):
        assert meta.has_field(fieldname), f"Missing migrated closing field: {fieldname}"

    payment_meta = frappe.get_meta("Payment Entry")
    for fieldname in (
        "retailedge_cash_custody_type",
        "retailedge_pos_opening_shift",
        "retailedge_cashier",
    ):
        assert payment_meta.has_field(fieldname), f"Missing custody field: {fieldname}"

    overrides = frappe.get_hooks("override_whitelisted_methods")
    providers = list(overrides.get(NATIVE_CLOSING_API) or [])
    assert RETAIL_CLOSING_API in providers, providers
    assert EXTENSION_CLOSING_API in providers, providers
    assert providers[-1] in {RETAIL_CLOSING_API, EXTENSION_CLOSING_API}, providers
    for path in (NATIVE_CLOSING_API, RETAIL_CLOSING_API, EXTENSION_CLOSING_API):
        assert callable(frappe.get_attr(path)), f"Missing native or extension provider: {path}"

    events = frappe.get_hooks("doc_events")
    assert CLOSING_VALIDATE in _handlers(events, "validate")
    assert DRAFT_GUARD in _handlers(events, "before_submit")
    assert callable(frappe.get_attr(DRAFT_GUARD))

    return {
        "installed_apps": sorted(required_apps),
        "closing_override_winner": providers[-1],
        "closing_fields": [
            "retailedge_cashier_expense_total",
            "retailedge_cash_deposit_total",
            "retailedge_cash_deposit_count",
        ],
        "cash_deposit_fields_verified": True,
        "cashier_expense_validate_registered": True,
        "saved_draft_guard_registered": True,
        "site_mutations": 0,
    }
