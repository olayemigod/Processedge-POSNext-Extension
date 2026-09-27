from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
API_SOURCE = (ROOT / "api.py").read_text(encoding="utf-8")
JS_SOURCE = (
    ROOT / "public" / "js" / "processedge_posnext_override.js"
).read_text(encoding="utf-8")


def test_pre_edgesuite_retailedge_contract_is_detected():
    assert 'RETAILEDGE_LEGACY_CONTEXT_METHOD = "retailedge.api.get_cashier_expense_entry_context"' in API_SOURCE
    assert "def _legacy_cashier_expense_bridge_context" in API_SOURCE
    assert '"bridge_mode": "legacy_retailedge"' in API_SOURCE
    assert '"requires_edgesuite": 0' in API_SOURCE


def test_legacy_bridge_normalizes_old_cashier_context_for_pos_ui():
    assert '"available_cash": frappe.utils.flt(' in API_SOURCE
    assert 'context.get("available_shift_cash_before_expense")' in API_SOURCE
    assert '"opening_shift": resolved_shift' in API_SOURCE
    assert '"allow_expense_date_edit": bool(' in API_SOURCE


def test_legacy_creation_keeps_retailedge_controller_authoritative():
    assert "def _create_legacy_retailedge_cashier_expense" in API_SOURCE
    assert "doc = frappe.new_doc(RETAILEDGE_EXPENSE_DOCTYPE)" in API_SOURCE
    assert "doc.expense_category = category" in API_SOURCE
    assert "doc.amount = amount" in API_SOURCE
    assert "doc.insert()" in API_SOURCE
    assert "doc.submit()" in API_SOURCE
    assert "doc.company =" not in API_SOURCE[API_SOURCE.index("def _create_legacy_retailedge_cashier_expense"):]


def test_legacy_category_search_uses_permission_aware_frappe_get_list():
    assert "def _search_legacy_cashier_expense_categories" in API_SOURCE
    assert "rows = frappe.get_list(" in API_SOURCE
    assert '"is_active", "=", 1' in API_SOURCE


def test_modern_retailedge_still_has_priority_when_available():
    create_start = API_SOURCE.index("def create_retailedge_cashier_expense")
    create_source = API_SOURCE[create_start:]
    assert "_get_retailedge_method(RETAILEDGE_CREATE_METHOD)" in create_source
    assert "if method:" in create_source
    assert "return method(values=values)" in create_source
    assert "return _create_legacy_retailedge_cashier_expense(values=values)" in create_source


def test_pos_modal_remains_extension_owned_and_edgesuite_free():
    assert "async function openCashierExpenseDialog()" in JS_SOURCE
    assert 'document.createElement("div")' in JS_SOURCE
    assert "window.EdgeSuiteUI" not in JS_SOURCE
