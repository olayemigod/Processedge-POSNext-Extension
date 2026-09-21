import frappe


POSNEXT_PERMISSION_ROLES = frozenset({"POSNext Cashier", "Nexus POS Manager"})

POSNEXT_MANAGED_DOCTYPES = (
    "Account",
    "Promotional Scheme",
    "POS Closing Entry",
    "Sales Invoice",
    "Territory",
    "POS Opening Entry",
    "POS Profile",
    "Payment Entry",
    "Customer",
    "Bin",
    "Item",
    "Warehouse",
    "Serial and Batch Bundle",
    "Journal Entry",
)

PERMISSION_FIELDS = (
    "role",
    "permlevel",
    "if_owner",
    "read",
    "write",
    "create",
    "delete",
    "submit",
    "cancel",
    "amend",
    "report",
    "export",
    "import",
    "share",
    "print",
    "email",
    "select",
)


def _permission_key(row):
    return (
        row.get("role"),
        int(row.get("permlevel") or 0),
        int(row.get("if_owner") or 0),
    )


def has_posnext_permission_row(custom_rows):
    return any(row.get("role") in POSNEXT_PERMISSION_ROLES for row in custom_rows)


def get_missing_standard_permission_rows(standard_rows, custom_rows):
    """Return standard permission rows missing from a custom permission matrix.

    Existing custom rows are never modified or removed. The key deliberately
    follows Frappe's role/permission-level/if-owner identity so intentional
    edits to an existing custom row are preserved.
    """
    present = {_permission_key(row) for row in custom_rows}
    missing = []

    for row in standard_rows:
        key = _permission_key(row)
        if key in present:
            continue

        missing.append(row)
        present.add(key)

    return missing


def _protection_enabled():
    settings_doctype = "ProcessEdge POSNext Settings"
    fieldname = "protect_erpnext_permissions_from_posnext"

    if not frappe.db.exists("DocType", settings_doctype):
        return True

    meta = frappe.get_meta(settings_doctype)
    if not meta.has_field(fieldname):
        return True

    value = frappe.db.get_single_value(settings_doctype, fieldname)
    return value not in (0, "0", False)


def _make_custom_permission(doctype, standard_row):
    values = {
        fieldname: standard_row.get(fieldname)
        for fieldname in PERMISSION_FIELDS
    }
    values.update(
        {
            "doctype": "Custom DocPerm",
            "parent": doctype,
            "parenttype": "DocType",
            "parentfield": "permissions",
        }
    )

    return frappe.get_doc(values)


def ensure_posnext_permission_compatibility():
    """Preserve ERPNext's role baseline alongside POSNext Custom DocPerm rows.

    POSNext distributes Custom DocPerm fixtures for standard ERPNext DocTypes.
    Frappe treats any Custom DocPerm rows for a DocType as the complete
    permission matrix, not as additions. A lone POSNext Cashier row can
    therefore remove effective access for Accounts User, Sales User, and other
    normal ERPNext roles.

    This guard is additive and idempotent:
    - it runs only when a POSNext-managed role is present for the DocType;
    - it inserts only missing standard ERPNext permission rows;
    - it never updates or deletes an existing custom permission row;
    - it never changes POSNext role permissions;
    - it never touches transactional or accounting documents.
    """
    summary = {
        "enabled": True,
        "checked": 0,
        "managed": 0,
        "restored": 0,
        "doctypes": {},
    }

    if not _protection_enabled():
        summary["enabled"] = False
        return summary

    for doctype in POSNEXT_MANAGED_DOCTYPES:
        if not frappe.db.exists("DocType", doctype):
            continue

        summary["checked"] += 1

        custom_rows = frappe.get_all(
            "Custom DocPerm",
            filters={"parent": doctype},
            fields=list(PERMISSION_FIELDS),
        )

        if not has_posnext_permission_row(custom_rows):
            continue

        summary["managed"] += 1

        standard_rows = frappe.get_all(
            "DocPerm",
            filters={"parent": doctype},
            fields=list(PERMISSION_FIELDS),
        )

        missing_rows = get_missing_standard_permission_rows(
            standard_rows,
            custom_rows,
        )

        restored_roles = []

        for row in missing_rows:
            _make_custom_permission(doctype, row).insert(ignore_permissions=True)
            restored_roles.append(row.get("role"))

        if restored_roles:
            summary["restored"] += len(restored_roles)
            summary["doctypes"][doctype] = restored_roles

    if summary["restored"]:
        frappe.clear_cache()

    return summary
