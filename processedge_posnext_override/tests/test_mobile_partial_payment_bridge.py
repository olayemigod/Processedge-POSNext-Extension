from pathlib import Path


SOURCE = (
    Path(__file__).resolve().parents[1]
    / "public"
    / "js"
    / "processedge_posnext_override.js"
).read_text(encoding="utf-8")


def test_mobile_partial_payment_bridge_is_present():
    assert 'data-processedge-mobile-partial-payment' in SOURCE
    assert 'normalizedButtonText(item) === "Partial Payment"' in SOURCE
    assert "currentDesktopButton.click()" in SOURCE


def test_bridge_stands_down_when_native_mobile_fix_exists():
    assert "nativeMobilePartialButton" in SOURCE
    assert "removeMobilePartialPaymentBridge(mobileSection)" in SOURCE
    assert (
        '!button.hasAttribute(MOBILE_PARTIAL_PAYMENT_ATTR)' in SOURCE
        and 'normalizedButtonText(button) === "Partial Payment"' in SOURCE
    )


def test_partial_payment_bridge_runs_independently_of_posting_date_setting():
    patch_ui = SOURCE.index("function patchUI()")
    partial_bridge = SOURCE.index("injectMobilePartialPaymentAction();", patch_ui)
    posting_date_gate = SOURCE.index(
        "if (!STATE.settings || !STATE.settings.allow_editing_posting_date)",
        patch_ui,
    )
    assert partial_bridge < posting_date_gate
