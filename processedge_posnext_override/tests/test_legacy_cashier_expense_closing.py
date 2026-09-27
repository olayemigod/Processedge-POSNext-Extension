from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SOURCE = (
    ROOT / "overrides" / "closing_shift.py"
).read_text(encoding="utf-8")
HOOKS = (ROOT / "hooks.py").read_text(encoding="utf-8")


def test_posnext_closing_data_is_wrapped():
    assert '"pos_next.api.shifts.get_closing_shift_data"' in HOOKS
    assert (
        '"processedge_posnext_override.overrides.closing_shift.get_closing_shift_data"'
        in HOOKS
    )
    assert "from pos_next.api.shifts import get_closing_shift_data as posnext_get_closing_shift_data" in SOURCE


def test_legacy_only_adapter_stands_down_for_modern_retailedge():
    assert "def _has_modern_retailedge_pos_expense_bridge" in SOURCE
    assert "retailedge.pos_cashier_expense.get_pos_cashier_expense_capabilities" in SOURCE
    assert "or _has_modern_retailedge_pos_expense_bridge()" in SOURCE


def test_only_submitted_legacy_expenses_are_counted():
    assert '"linked_pos_opening_shift": opening_shift' in SOURCE
    assert '"docstatus": 1' in SOURCE
    assert '!= "Cancelled"' in SOURCE


def test_legacy_expenses_reduce_posnext_cash_expected_amount():
    assert 'cash_row["expected_amount"] = flt(cash_row.get("expected_amount")) - total' in SOURCE
    assert 'cash_row["expense_amount"] = flt(cash_row.get("expense_amount")) + total' in SOURCE


def test_legacy_expenses_reuse_posnext_expense_summary_fields():
    assert 'closing_data["expenses_total"]' in SOURCE
    assert 'closing_data["expenses_count"]' in SOURCE
    assert 'closing_data["total_pos_expenses"]' in SOURCE
    assert 'pos_expenses.extend(_legacy_expense_display_row(row) for row in rows)' in SOURCE
