from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SOURCE = (
    ROOT / "public" / "js" / "processedge_posnext_override.js"
).read_text(encoding="utf-8")


def test_optional_phone_fallback_does_not_mutate_native_disabled_state():
    start = SOURCE.index("function ensureOptionalPhoneFallback")
    end = SOURCE.index("function bindLegacyOptionalPhoneInputs", start)
    block = SOURCE[start:end]

    assert "nativeCreateButton.disabled" in block
    assert "nativeCreateButton.disabled =" not in block
    assert 'nativeCreateButton.setAttribute("disabled"' not in block
    assert 'nativeCreateButton.removeAttribute("disabled"' not in block


def test_optional_phone_fallback_replaces_only_erroneously_disabled_native_action():
    start = SOURCE.index("function ensureOptionalPhoneFallback")
    end = SOURCE.index("function bindLegacyOptionalPhoneInputs", start)
    block = SOURCE[start:end]

    assert "canCreateWithoutPhone" in block
    assert "!nativeCreateButton.disabled" in block
    assert 'data-processedge-create-customer-without-phone' in block
    assert 'background:#2563eb' in block
    assert "createCustomerWithoutPhone(dialog, fallback)" in block


def test_native_customer_action_is_restored_when_fallback_not_needed():
    assert "function removeOptionalPhoneFallback" in SOURCE
    assert 'nativeButton.style.display = ""' in SOURCE
    assert 'data-processedge-hidden-for-phone-fallback' in SOURCE


def test_customer_dialog_cannot_retrigger_patch_loop_via_disabled_attribute():
    observer_start = SOURCE.index("function startObserver()")
    observer_block = SOURCE[observer_start:]

    assert "childList: true" in observer_block
    assert "characterData: true" in observer_block
    assert "attributes: true" not in observer_block
    assert 'attributeFilter: ["disabled"]' not in observer_block


def test_partial_payment_refresh_remains_interaction_driven():
    assert '["click", "input", "change"]' in SOURCE
    assert "schedulePaymentBridgeRefresh" in SOURCE
    assert "injectMobilePartialPaymentAction();" in SOURCE
