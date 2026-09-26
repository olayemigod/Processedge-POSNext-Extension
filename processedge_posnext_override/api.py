import frappe
from frappe import _

from processedge_posnext_override.overrides.pos_settings import (
    ensure_posnext_settings_sync,
    get_current_pos_profile,
    get_effective_posting_date_editability,
    get_effective_rate_editability,
    get_app_settings_doc,
    posnext_supports_customer_phone_policy,
)


@frappe.whitelist()
def get_pos_override_settings(pos_profile=None):
    settings = get_app_settings_doc()
    roles = []
    raw_roles = settings.editable_price_roles or ""
    if raw_roles:
        roles = [role.strip() for role in raw_roles.replace("\n", ",").split(",") if role.strip()]
    pos_profile = pos_profile or get_current_pos_profile()
    require_customer_phone = settings.get("require_customer_phone")
    if require_customer_phone is None:
        require_customer_phone = 1
    return {
        "allow_editable_selling_price": int(get_effective_rate_editability(pos_profile=pos_profile)),
        "allow_editing_posting_date": int(
            get_effective_posting_date_editability(pos_profile=pos_profile)
        ),
        "require_customer_phone": int(require_customer_phone),
        "native_customer_phone_policy": int(posnext_supports_customer_phone_policy()),
        "editable_price_roles": roles,
        "pos_profile": pos_profile,
        "posting_date": frappe.utils.nowdate(),
    }


@frappe.whitelist()
def sync_posnext_settings():
    if not frappe.has_permission("System Settings", "write") and "System Manager" not in frappe.get_roles():
        frappe.throw(_("Only a System Manager can sync POSNext settings."))

    ensure_posnext_settings_sync()
    return {"ok": True}

RETAILEDGE_APP = "retailedge"
RETAILEDGE_CAPABILITY_METHOD = "retailedge.pos_cashier_expense.get_pos_cashier_expense_capabilities"
RETAILEDGE_GUIDED_CONTEXT_METHOD = "retailedge.guided_cashier_expense.get_guided_cashier_expense_context"
RETAILEDGE_CATEGORY_SEARCH_METHOD = "retailedge.guided_cashier_expense.search_guided_expense_categories"
RETAILEDGE_CREATE_METHOD = "retailedge.pos_cashier_expense.create_pos_cashier_expense"


def _get_retailedge_method(method_path):
    if RETAILEDGE_APP not in frappe.get_installed_apps():
        return None
    try:
        return frappe.get_attr(method_path)
    except (ImportError, AttributeError):
        return None


def _require_retailedge_method(method_path):
    method = _get_retailedge_method(method_path)
    if not method:
        frappe.throw(
            _("RetailEdge Cashier Expense integration is not available on this site.")
        )
    return method


@frappe.whitelist()
def get_cashier_expense_bridge_context(pos_profile=None, opening_shift=None):
    """Return only permission-aware RetailEdge POS expense context.

    The POSNext extension remains a presentation bridge. RetailEdge resolves and
    validates company, branch, shift, accounts, category access and posting policy.
    """
    capability_method = _get_retailedge_method(RETAILEDGE_CAPABILITY_METHOD)
    if not capability_method:
        return {
            "available": 0,
            "enabled": 0,
            "show_action": 0,
            "ready": 0,
            "reason": _("RetailEdge is not installed or the POS expense bridge is unavailable."),
            "categories": [],
        }

    capabilities = capability_method(
        pos_profile=pos_profile,
        opening_shift=opening_shift,
    ) or {}

    response = {
        "available": 1,
        **capabilities,
        "categories": [],
        "guided": {},
    }

    if not capabilities.get("show_action") or not capabilities.get("ready"):
        return response

    guided_method = _get_retailedge_method(RETAILEDGE_GUIDED_CONTEXT_METHOD)
    category_method = _get_retailedge_method(RETAILEDGE_CATEGORY_SEARCH_METHOD)
    if not guided_method or not category_method:
        response["ready"] = 0
        response["reason"] = _("RetailEdge Cashier Expense entry services are unavailable.")
        return response

    guided = guided_method() or {}
    company = ((guided.get("context") or {}).get("company") or "").strip()
    response["guided"] = guided
    response["categories"] = category_method(
        txt="",
        company=company or None,
        limit=20,
    ) or []
    return response


@frappe.whitelist()
def search_cashier_expense_categories(txt="", company=None, limit=20):
    method = _require_retailedge_method(RETAILEDGE_CATEGORY_SEARCH_METHOD)
    return method(txt=txt or "", company=company or None, limit=limit)


@frappe.whitelist(methods=["POST"])
def create_retailedge_cashier_expense(values=None):
    method = _require_retailedge_method(RETAILEDGE_CREATE_METHOD)
    return method(values=values)

