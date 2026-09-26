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

def test_retailedge_cashier_expense_bridge_is_optional_and_governed():
    hooks = (ROOT / "processedge_posnext_override" / "hooks.py").read_text(encoding="utf-8")
    api = (ROOT / "processedge_posnext_override" / "api.py").read_text(encoding="utf-8")
    js = (
        ROOT
        / "processedge_posnext_override"
        / "public"
        / "js"
        / "processedge_posnext_override.js"
    ).read_text(encoding="utf-8")

    assert 'required_apps = ["erpnext", "pos_next"]' in hooks
    assert 'RETAILEDGE_APP = "retailedge"' in api
    assert "frappe.get_installed_apps()" in api
    assert "retailedge.pos_cashier_expense.get_pos_cashier_expense_capabilities" in api
    assert "retailedge.pos_cashier_expense.create_pos_cashier_expense" in api
    assert "retailedge.guided_cashier_expense.search_guided_expense_categories" in api
    assert "get_cashier_expense_bridge_context" in api
    assert "search_cashier_expense_categories" in api
    assert "create_retailedge_cashier_expense" in api

    assert "data-processedge-cashier-expense-action" in js
    assert "Cashier Expense" in js
    assert "client_request_id" in js
    assert "crypto.randomUUID" in js
    assert "processedge_posnext_override.api.create_retailedge_cashier_expense" in js
    assert "processedge_posnext_override.api.search_cashier_expense_categories" in js
    assert "doc.company =" not in js
    assert "doc.branch =" not in js
    assert "doc.payment_account =" not in js



def test_pos_vite_page_injection_contract():
    hooks = (ROOT / "processedge_posnext_override" / "hooks.py").read_text(encoding="utf-8")
    request_hooks = (ROOT / "processedge_posnext_override" / "request_hooks.py").read_text(encoding="utf-8")

    assert 'after_request = ["processedge_posnext_override.request_hooks.inject_pos_page_script"]' in hooks
    assert '"/assets/processedge_posnext_override/js/processedge_posnext_override.js"' in request_hooks
    assert 'path == "/pos" or path.startswith("/pos/")' in request_hooks
    assert '"text/html"' in request_hooks
    assert "response.get_data(as_text=True)" in request_hooks
    assert "response.set_data(html)" in request_hooks


def test_pos_runtime_requests_are_isolated_and_vite_compatible():
    js = (
        ROOT
        / "processedge_posnext_override"
        / "public"
        / "js"
        / "processedge_posnext_override.js"
    ).read_text(encoding="utf-8")

    assert "frappe.call is unavailable" not in js
    assert "window.frappe.call" not in js
    assert 'CSRF_TOKEN_ENDPOINT = "/api/method/pos_next.api.utilities.get_csrf_token"' in js
    assert '"X-Frappe-CSRF-Token": csrfToken' in js
    assert 'method: "GET"' in js
    assert 'method: "POST"' in js

    assert "INVOICE_PATCH_FIELDS" in js
    assert '"pos_next.api.invoices.update_invoice", "data"' in js
    assert '"pos_next.api.invoices.submit_invoice", "invoice"' in js
    assert '"pos_next.api.invoices.apply_offers", "invoice_data"' in js
    assert "if (url && isPOSPage() && invoicePatchField(url))" in js
    assert "!STATE.settings.allow_editing_posting_date" in js

    # Normal POSNext API requests must remain byte-for-byte untouched. The request
    # wrapper may only transform the three invoice endpoints above.
    assert "function parseBody(body)" not in js
    assert "patchRequestPayload(url, init)" in js


def test_pos_ui_and_posting_date_governance_contract():
    api = (ROOT / "processedge_posnext_override" / "api.py").read_text(encoding="utf-8")
    pos_settings = (
        ROOT / "processedge_posnext_override" / "overrides" / "pos_settings.py"
    ).read_text(encoding="utf-8")
    sales_invoice = (
        ROOT / "processedge_posnext_override" / "overrides" / "sales_invoice.py"
    ).read_text(encoding="utf-8")
    js = (
        ROOT
        / "processedge_posnext_override"
        / "public"
        / "js"
        / "processedge_posnext_override.js"
    ).read_text(encoding="utf-8")

    assert "get_effective_posting_date_editability" in pos_settings
    assert "allow_change_posting_date" in pos_settings
    assert "get_effective_posting_date_editability(pos_profile=pos_profile)" in api
    assert "get_effective_posting_date_editability(" in sales_invoice

    assert "data-processedge-posting-date-global" in js
    assert "createPostingDateHeaderField" in js
    assert "button[title='POS Next']" in js
    assert "processedge.cashierExpenseFloatingPosition" in js
    assert "pointerdown" in js
    assert "pointermove" in js
    assert "touch-action:none" in js
    assert "M7 3h10a2 2 0 012 2v16" in js


def test_posting_date_request_helper_is_defined():
    js = (
        ROOT
        / "processedge_posnext_override"
        / "public"
        / "js"
        / "processedge_posnext_override.js"
    ).read_text(encoding="utf-8")

    helper = js.index("function writeInvoiceDateFields(payload)")
    caller = js.index("writeInvoiceDateFields(payload);")
    assert helper >= 0
    assert caller > helper
    assert "payload.posting_date = STATE.postingDate" in js
    assert "payload.transaction_date = STATE.postingDate" in js
    assert 'payload.doctype === "Sales Invoice"' in js
    assert "payload.set_posting_time = 1" in js
