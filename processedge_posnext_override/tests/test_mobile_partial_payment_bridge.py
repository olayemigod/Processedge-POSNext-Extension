from pathlib import Path


SOURCE = (
    Path(__file__).resolve().parents[1]
    / "public"
    / "js"
    / "processedge_posnext_override.js"
).read_text(encoding="utf-8")


def test_mobile_partial_payment_bridge_uses_posnext_completion_state():
    assert 'data-processedge-mobile-partial-payment' in SOURCE
    assert "findDesktopCompletionButton" in SOURCE
    assert "desktopCompletionButton.disabled" in SOURCE
    assert "currentDesktopButton.click()" in SOURCE


def test_bridge_only_appears_while_outstanding_pay_action_exists():
    assert "hasOutstandingPayAction" in SOURCE
    assert "/^Pay\\s+/i.test(normalizedButtonText(button))" in SOURCE


def test_bridge_stands_down_when_native_mobile_fix_exists():
    assert "nativeMobileCompletionButton" in SOURCE
    assert "removeMobilePartialPaymentBridge(mobileSection)" in SOURCE
    assert (
        "!button.hasAttribute(MOBILE_PARTIAL_PAYMENT_ATTR)" in SOURCE
        and "isNativeCompletionButton(button)" in SOURCE
    )


def test_observer_tracks_disabled_state_changes():
    assert "attributes: true" in SOURCE
    assert 'attributeFilter: ["disabled"]' in SOURCE


def test_partial_payment_bridge_runs_independently_of_posting_date_setting():
    patch_ui = SOURCE.index("function patchUI()")
    partial_bridge = SOURCE.index("injectMobilePartialPaymentAction();", patch_ui)
    posting_date_gate = SOURCE.index(
        "if (!STATE.settings || !STATE.settings.allow_editing_posting_date)",
        patch_ui,
    )
    assert partial_bridge < posting_date_gate


def test_payment_interactions_explicitly_refresh_bridge():
    assert "bindPaymentBridgeRefreshEvents" in SOURCE
    assert '["click", "input", "change"]' in SOURCE
    assert "schedulePaymentBridgeRefresh" in SOURCE
    assert "requestAnimationFrame" in SOURCE
