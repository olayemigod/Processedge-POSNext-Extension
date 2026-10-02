from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
APP = ROOT / "processedge_posnext_override"
JS = APP / "public" / "js" / "processedge_posnext_override.js"
API = APP / "api.py"
HOOKS = APP / "request_hooks.py"
SETTINGS = (
    APP
    / "doctype"
    / "processedge_posnext_settings"
    / "processedge_posnext_settings.json"
)


def test_pos_printing_settings_are_explicit_and_default_off():
    doc = json.loads(SETTINGS.read_text())
    fields = {field["fieldname"]: field for field in doc["fields"]}

    assert fields["enable_edgesuite_receipt_printing"]["default"] == "0"
    assert fields["auto_print_edgesuite_receipts"]["default"] == "0"
    assert fields["auto_print_edgesuite_receipts"]["depends_on"] == (
        "enable_edgesuite_receipt_printing"
    )


def test_pos_page_injection_uses_hashed_lightweight_edgesuite_bundle():
    source = HOOKS.read_text()

    for expected in (
        'EDGE_SUITE_PRINT_ASSET = "edgeui_print.bundle.js"',
        "get_assets_json",
        '"edgesuite_ui" not in frappe.get_installed_apps()',
        "_resolve_edge_suite_print_script()",
        "sources.append(edge_print_script)",
        "sources.append(POS_PAGE_SCRIPT)",
    ):
        assert expected in source

    assert source.index("sources.append(edge_print_script)") < source.index(
        "sources.append(POS_PAGE_SCRIPT)"
    )


def test_server_bridge_delegates_business_and_profile_authority():
    source = API.read_text()

    for expected in (
        'EDGESUITE_PROFILE_METHOD = "edgesuite_ui.api.printing.resolve_print_profile"',
        'RETAILEDGE_RECEIPT_METHOD = "retailedge.thermal_receipt.get_thermal_receipt_payload"',
        "def get_edgesuite_receipt_print_payload",
        'receipt_method(document="Sales Invoice", name=invoice_name)',
        'product_key="retailedge"',
        'purpose="Receipt"',
        '"profile": profile',
        '"receipt": receipt',
    ):
        assert expected in source

    print_endpoint = source.split(
        "def get_edgesuite_receipt_print_payload", 1
    )[1].split("def _require_retailedge_method", 1)[0]
    for forbidden in (
        "ignore_permissions=True",
        "navigator.serial",
        "SerialPort",
    ):
        assert forbidden not in print_endpoint


def test_auto_print_yields_to_posnext_native_auto_printing():
    source = API.read_text()

    for expected in (
        "print_receipt_on_order_complete",
        '"silent_print"',
        "not native_auto_print",
        "not native_silent_print",
        '"edgesuite_auto_print_effective": int(auto_effective)',
        "prevent duplicate receipts",
    ):
        assert expected in source


def test_browser_bridge_observes_only_successful_fresh_online_submissions():
    source = JS.read_text()

    for expected in (
        'SUBMIT_INVOICE_ENDPOINT = "pos_next.api.invoices.submit_invoice"',
        "response?.ok",
        "response.clone().json()",
        "submittedInvoiceFromResponse(payload)",
        "requestContainsOfflineInvoice(nextInit)",
        "STATE.printing.lastSubmittedInvoice = invoice",
        "edgeSuiteAutoPrintEnabled()",
    ):
        assert expected in source

    assert "!requestContainsOfflineInvoice(nextInit)" in source
    assert "offline_id" in source


def test_submit_response_parser_keeps_frappe_result_object_not_inner_message_text():
    source = JS.read_text()
    parser = source.split("function submittedInvoiceFromResponse(payload)", 1)[1].split(
        "async function observeSubmittedInvoiceResponse", 1
    )[0]

    assert 'typeof payload.message === "object"' in parser
    assert 'String(result?.name || "")' in parser
    assert "message?.message || message" not in parser


def test_pos_receipt_printing_uses_only_shared_edgesuite_transport():
    source = JS.read_text()

    for expected in (
        "window.EdgeSuitePrint",
        "adapter.devices.connectBoundSerial",
        "adapter.profiles.connectionOptions(profile)",
        "adapter.profiles.receiptOptions(profile)",
        "adapter.printReceipt(documentPayload)",
        'data-processedge-edgesuite-print-receipt',
        'button.textContent = "Print Receipt"',
        "openEdgeSuitePrinterSetup",
    ):
        assert expected in source

    for forbidden in (
        "navigator.serial",
        "requestPort(",
        "getPorts(",
        "bluetoothServiceClassId",
        "0x1b",
        "0x1d",
    ):
        assert forbidden not in source


def test_receipt_success_action_uses_invoice_identity_before_english_copy():
    source = JS.read_text()
    section = source.split("function injectEdgeSuiteReceiptAction()", 1)[1].split(
        "async function loadCashierExpenseBridge", 1
    )[0]

    assert "rememberedName" in section
    assert "text.includes(rememberedName)" in section
    assert "actionGroups.at(-1)" in section
    assert "/Print Invoice/i" in section


def test_pos_exposes_persistent_printer_setup_action():
    source = JS.read_text()

    for expected in (
        "function injectEdgeSuitePrinterAction()",
        'data-processedge-printer-action',
        '"Receipt Printer — Connected"',
        '"Receipt Printer — Setup"',
        'createPrinterActionButton("sidebar")',
        'createPrinterActionButton("header")',
        "openEdgeSuitePrinterSetup({",
        "injectEdgeSuitePrinterAction();",
    ):
        assert expected in source

    assert "edgeSuitePrinterConnected()" in source


def test_edgesuite_auto_print_is_session_deduplicated_and_post_transaction():
    source = JS.read_text()

    assert "autoPrintedInvoices: new Set()" in source
    assert "STATE.printing.autoPrintedInvoices.has(name)" in source
    assert "STATE.printing.autoPrintedInvoices.add(name)" in source
    assert "Sale completed, but the EdgeSuite receipt did not print." in source


def test_offline_printing_remains_posnext_owned():
    source = JS.read_text()

    assert "requestContainsOfflineInvoice" in source
    assert "offline_id" in source
    assert "cacheOfflineReceiptPayload" not in source
    assert "Offline Invoice Sync" not in source


def test_pos_printer_setup_action_is_discoverable_on_desktop_and_mobile():
    source = JS.read_text()

    for expected in (
        "function injectEdgeSuitePrinterAction()",
        "function createPrinterActionButton",
        "data-processedge-printer-action",
        "Receipt Printer — Setup",
        "Receipt Printer — Connected",
        "button[title='POS Next'], button[aria-label='POS Next']",
        "settingsButton",
        "injectEdgeSuitePrinterAction();",
        'purpose: "Receipt"',
        'product_key: "retailedge"',
        'params.set("company", company)',
        'params.set("branch", branch)',
    ):
        assert expected in source
