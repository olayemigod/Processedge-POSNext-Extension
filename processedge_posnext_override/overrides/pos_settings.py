import frappe
from frappe import _


APP_SETTINGS_DOCTYPE = "ProcessEdge POSNext Settings"
POS_OPENING_SHIFT_DOCTYPE = "POS Opening Shift"


def get_app_settings_doc():
    if frappe.db.exists("DocType", APP_SETTINGS_DOCTYPE):
        try:
            return frappe.get_cached_doc(APP_SETTINGS_DOCTYPE)
        except frappe.DoesNotExistError:
            doc = frappe.get_doc({"doctype": APP_SETTINGS_DOCTYPE})
            doc.insert(ignore_permissions=True)
            return doc

    frappe.throw(_("{0} DocType is not installed yet.").format(APP_SETTINGS_DOCTYPE))


def get_app_flags():
    doc = get_app_settings_doc()
    return {
        "allow_user_to_edit_rate": int(doc.allow_editable_selling_price or 0),
        "allow_change_posting_date": int(doc.allow_editing_posting_date or 0),
    }


def is_global_rate_editing_enabled():
    return int(get_app_settings_doc().allow_editable_selling_price or 0)


def get_current_pos_profile(user=None):
    user = user or frappe.session.user
    if not user or user == "Guest" or not frappe.db.exists("DocType", POS_OPENING_SHIFT_DOCTYPE):
        return None

    fields = ["pos_profile"]
    order_by = "modified desc"

    if frappe.db.has_column(POS_OPENING_SHIFT_DOCTYPE, "status"):
        entries = frappe.get_all(
            POS_OPENING_SHIFT_DOCTYPE,
            filters={"user": user, "status": "Open"},
            fields=fields,
            order_by=order_by,
            limit=1,
        )
        if entries and entries[0].get("pos_profile"):
            return entries[0].get("pos_profile")

    if frappe.db.has_column(POS_OPENING_SHIFT_DOCTYPE, "docstatus"):
        entries = frappe.get_all(
            POS_OPENING_SHIFT_DOCTYPE,
            filters={"user": user, "docstatus": 1},
            fields=fields,
            order_by=order_by,
            limit=1,
        )
        if entries and entries[0].get("pos_profile"):
            return entries[0].get("pos_profile")

    entries = frappe.get_all(
        POS_OPENING_SHIFT_DOCTYPE,
        filters={"user": user},
        fields=fields,
        order_by=order_by,
        limit=1,
    )
    if entries:
        return entries[0].get("pos_profile")

    return None


def get_pos_settings_doc(pos_profile):
    if not pos_profile or not frappe.db.exists("DocType", "POS Settings"):
        return None

    name = None
    if frappe.db.has_column("POS Settings", "pos_profile"):
        name = frappe.db.get_value("POS Settings", {"pos_profile": pos_profile}, "name")

    if not name and frappe.db.exists("POS Settings", pos_profile):
        name = pos_profile

    if not name:
        return None

    return frappe.get_cached_doc("POS Settings", name)


def get_effective_rate_editability(pos_profile=None, pos_settings_doc=None):
    if not is_global_rate_editing_enabled():
        return 0

    pos_settings_doc = pos_settings_doc or get_pos_settings_doc(pos_profile)
    if pos_settings_doc is None:
        return 1

    return int(pos_settings_doc.allow_user_to_edit_rate or 0)


def get_effective_posting_date_editability(pos_profile=None, pos_settings_doc=None):
    """Resolve posting-date permission from the active POS profile.

    POSNext already stores this policy per POS Settings record. The ProcessEdge
    setting continues to act as the synchronized default, while the active
    profile value is the runtime source of truth when that record exists.
    """

    pos_profile = pos_profile or get_current_pos_profile()
    pos_settings_doc = pos_settings_doc or get_pos_settings_doc(pos_profile)
    if pos_settings_doc is not None:
        return int(pos_settings_doc.allow_change_posting_date or 0)

    return int(get_app_settings_doc().allow_editing_posting_date or 0)


def apply_app_settings_to_doc(doc, method=None):
    flags = get_app_flags()
    doc.allow_change_posting_date = flags["allow_change_posting_date"]
    if not flags["allow_user_to_edit_rate"]:
        doc.allow_user_to_edit_rate = 0


def ensure_posnext_settings_sync():
    if not frappe.db.exists("DocType", "POS Settings"):
        return

    flags = get_app_flags()
    pos_settings_names = frappe.get_all("POS Settings", pluck="name")

    for name in pos_settings_names:
        current = frappe.db.get_value(
            "POS Settings",
            name,
            ["allow_user_to_edit_rate", "allow_change_posting_date"],
            as_dict=True,
        )
        if not current:
            continue

        updates = {}
        if not flags["allow_user_to_edit_rate"] and int(current.allow_user_to_edit_rate or 0) != 0:
            updates["allow_user_to_edit_rate"] = 0
        if int(current.allow_change_posting_date or 0) != flags["allow_change_posting_date"]:
            updates["allow_change_posting_date"] = flags["allow_change_posting_date"]

        if updates:
            frappe.db.set_value("POS Settings", name, updates, update_modified=False)

    frappe.clear_cache(doctype="POS Settings")


def get_pos_settings_override(pos_profile):
    from pos_next.pos_next.doctype.pos_settings.pos_settings import get_pos_settings

    settings = get_pos_settings(pos_profile)
    if not settings:
        settings = {}

    pos_settings_doc = get_pos_settings_doc(pos_profile)
    settings["allow_user_to_edit_rate"] = get_effective_rate_editability(
        pos_profile=pos_profile,
        pos_settings_doc=pos_settings_doc,
    )
    settings["allow_change_posting_date"] = get_effective_posting_date_editability(
        pos_profile=pos_profile,
        pos_settings_doc=pos_settings_doc,
    )
    return settings
