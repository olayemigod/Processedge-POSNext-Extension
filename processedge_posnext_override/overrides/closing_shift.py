from __future__ import annotations

import frappe
from frappe.utils import flt


RETAILEDGE_APP = "retailedge"
RETAILEDGE_EXPENSE_DOCTYPE = "RetailEdge Cashier Expense"
MODERN_RETAILEDGE_CAPABILITY_METHOD = (
    "retailedge.pos_cashier_expense.get_pos_cashier_expense_capabilities"
)


def _has_modern_retailedge_pos_expense_bridge() -> bool:
    if RETAILEDGE_APP not in frappe.get_installed_apps():
        return False
    try:
        frappe.get_attr(MODERN_RETAILEDGE_CAPABILITY_METHOD)
        return True
    except (ImportError, AttributeError):
        return False


def _legacy_retailedge_expenses(opening_shift: str):
    if (
        RETAILEDGE_APP not in frappe.get_installed_apps()
        or _has_modern_retailedge_pos_expense_bridge()
        or not frappe.db.exists("DocType", RETAILEDGE_EXPENSE_DOCTYPE)
    ):
        return []

    meta = frappe.get_meta(RETAILEDGE_EXPENSE_DOCTYPE)
    if not meta.has_field("linked_pos_opening_shift"):
        return []

    fields = ["name", "amount", "owner"]
    for fieldname in (
        "expense_category",
        "expense_account",
        "cashier",
        "description",
        "expense_status",
    ):
        if meta.has_field(fieldname):
            fields.append(fieldname)

    filters = {
        "linked_pos_opening_shift": opening_shift,
        "docstatus": 1,
    }
    rows = frappe.get_all(
        RETAILEDGE_EXPENSE_DOCTYPE,
        filters=filters,
        fields=fields,
        order_by="creation asc",
        limit_page_length=0,
    )

    return [
        row
        for row in rows
        if str(row.get("expense_status") or "").strip() != "Cancelled"
        and flt(row.get("amount")) > 0
    ]


def _cash_mode_of_payment(closing_data: dict) -> str:
    pos_profile = str(closing_data.get("pos_profile") or "").strip()
    if pos_profile and frappe.db.exists("POS Profile", pos_profile):
        meta = frappe.get_meta("POS Profile")
        if meta.has_field("posa_cash_mode_of_payment"):
            value = frappe.db.get_value(
                "POS Profile", pos_profile, "posa_cash_mode_of_payment"
            )
            if value:
                return str(value)
    return "Cash"


def _legacy_expense_display_row(row):
    category = str(row.get("expense_category") or "").strip()
    description = str(row.get("description") or "").strip()
    remarks = "RetailEdge Cashier Expense"
    if category:
        remarks += f" — {category}"
    if description:
        remarks += f": {description}"

    return {
        "journal_entry": None,
        "expense_account": row.get("expense_account"),
        "amount": flt(row.get("amount")),
        "cashier": row.get("cashier") or row.get("owner") or "",
        "remarks": remarks,
    }


def apply_legacy_retailedge_expenses(closing_data: dict, opening_shift: str):
    """Fold pre-EdgeSuite RetailEdge till expenses into POSNext closing data.

    POSNext remains the reconciliation model. This compatibility adapter only
    adds submitted legacy RetailEdge Cashier Expense rows to POSNext's existing
    expense totals and subtracts them from the cash payment row. It stands down
    automatically as soon as the modern RetailEdge POS expense bridge exists.
    """
    if not isinstance(closing_data, dict) or not opening_shift:
        return closing_data

    rows = _legacy_retailedge_expenses(opening_shift)
    if not rows:
        return closing_data

    total = sum(flt(row.get("amount")) for row in rows)
    if total <= 0:
        return closing_data

    cash_mode = _cash_mode_of_payment(closing_data)
    payments = closing_data.setdefault("payment_reconciliation", [])
    cash_row = next(
        (
            row
            for row in payments
            if str(row.get("mode_of_payment") or "").strip() == cash_mode
        ),
        None,
    )
    if cash_row is None:
        cash_row = {
            "mode_of_payment": cash_mode,
            "opening_amount": 0,
            "expected_amount": 0,
        }
        payments.append(cash_row)

    cash_row["expected_amount"] = flt(cash_row.get("expected_amount")) - total
    cash_row["expense_amount"] = flt(cash_row.get("expense_amount")) + total

    pos_expenses = closing_data.setdefault("pos_expenses", [])
    pos_expenses.extend(_legacy_expense_display_row(row) for row in rows)

    closing_data["expenses_total"] = flt(closing_data.get("expenses_total")) + total
    closing_data["expenses_count"] = int(closing_data.get("expenses_count") or 0) + len(rows)
    closing_data["total_pos_expenses"] = flt(
        closing_data.get("total_pos_expenses")
    ) + total
    closing_data["legacy_retailedge_expenses_total"] = total
    closing_data["legacy_retailedge_expenses_count"] = len(rows)
    return closing_data


@frappe.whitelist()
def get_closing_shift_data(opening_shift):
    """POSNext closing-data wrapper for legacy RetailEdge compatibility."""
    from pos_next.api.shifts import get_closing_shift_data as posnext_get_closing_shift_data

    closing_data = posnext_get_closing_shift_data(opening_shift)
    return apply_legacy_retailedge_expenses(closing_data, opening_shift)
