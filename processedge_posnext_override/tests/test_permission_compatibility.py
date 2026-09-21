from processedge_posnext_override.permissions import (
    get_missing_standard_permission_rows,
    has_posnext_permission_row,
)


def _row(role, read=1, permlevel=0, if_owner=0):
    return {
        "role": role,
        "read": read,
        "permlevel": permlevel,
        "if_owner": if_owner,
    }


def test_detects_posnext_managed_permission_matrix():
    assert has_posnext_permission_row([_row("POSNext Cashier")])
    assert has_posnext_permission_row([_row("Nexus POS Manager")])
    assert not has_posnext_permission_row([_row("Accounts User")])


def test_only_missing_standard_rows_are_selected():
    standard = [
        _row("Accounts User"),
        _row("Sales User"),
        _row("Accounts Manager"),
    ]
    custom = [
        _row("POSNext Cashier"),
        _row("Accounts User", read=0),
        _row("Site Specific Role"),
    ]

    missing = get_missing_standard_permission_rows(standard, custom)

    assert [row["role"] for row in missing] == [
        "Sales User",
        "Accounts Manager",
    ]


def test_existing_custom_standard_row_is_not_overwritten():
    standard = [_row("Accounts User", read=1)]
    custom = [_row("Accounts User", read=0), _row("POSNext Cashier")]

    assert get_missing_standard_permission_rows(standard, custom) == []


def test_duplicate_standard_keys_are_restored_once():
    standard = [
        _row("Accounts Manager"),
        _row("Accounts Manager"),
    ]
    custom = [_row("POSNext Cashier")]

    missing = get_missing_standard_permission_rows(standard, custom)

    assert len(missing) == 1
    assert missing[0]["role"] == "Accounts Manager"


def test_if_owner_rows_are_distinct_permission_entries():
    standard = [
        _row("Sales User", if_owner=0),
        _row("Sales User", if_owner=1),
    ]
    custom = [
        _row("POSNext Cashier"),
        _row("Sales User", if_owner=0),
    ]

    missing = get_missing_standard_permission_rows(standard, custom)

    assert len(missing) == 1
    assert missing[0]["role"] == "Sales User"
    assert missing[0]["if_owner"] == 1
