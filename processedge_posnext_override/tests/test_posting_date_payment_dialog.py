from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SOURCE = (
    ROOT / "public" / "js" / "processedge_posnext_override.js"
).read_text(encoding="utf-8")


def _posting_date_field_source():
    start = SOURCE.index("function createPostingDateField")
    end = SOURCE.index("function syncPostingDateInputs", start)
    return SOURCE[start:end]


def test_posting_date_stays_inside_native_payment_left_column():
    block = _posting_date_field_source()
    assert "findPaymentDialogLeftColumn" in SOURCE
    assert 'classes.contains("lg:col-span-2")' in SOURCE
    assert 'classes.contains("flex")' in SOURCE
    assert 'classes.contains("flex-col")' in SOURCE
    assert "leftColumn.insertBefore(wrapper, leftColumn.firstChild || null)" in block
    assert 'data-processedge-posting-date-placement' in block
    assert '"payment-left-column"' in block


def test_posting_date_does_not_add_third_child_to_payment_root_grid():
    block = _posting_date_field_source()
    assert 'querySelector(".bg-orange-50, .lg\\:col-span-2, .grid")' not in block
    assert "target.parentNode.insertBefore(wrapper, target)" not in block


def test_posting_date_change_refreshes_partial_payment_after_dom_settles():
    block = _posting_date_field_source()
    assert "syncPostingDateInputs(event.target.value, event.target);" in block
    assert "schedulePaymentBridgeRefresh();" in block


def test_posting_date_wrapper_cannot_shrink_salesperson_column_content():
    block = _posting_date_field_source()
    assert "flex-shrink-0" in block
