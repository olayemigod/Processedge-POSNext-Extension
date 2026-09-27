import frappe
from frappe import _

from processedge_posnext_override.overrides.pos_settings import (
    ensure_posnext_settings_sync,
    get_current_pos_profile,
    get_effective_posting_date_editability,
    get_effective_rate_editability,
    get_app_settings_doc,
    get_customer_phone_policy_source,
    get_effective_customer_phone_requirement,
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
    pos_settings_doc = None
    if pos_profile:
        from processedge_posnext_override.overrides.pos_settings import get_pos_settings_doc

        pos_settings_doc = get_pos_settings_doc(pos_profile)

    require_customer_phone = get_effective_customer_phone_requirement(
        pos_profile=pos_profile,
        pos_settings_doc=pos_settings_doc,
    )
    fallback_phone_policy = settings.get("require_customer_phone")
    if fallback_phone_policy is None:
        fallback_phone_policy = 1
    native_phone_policy = None
    if pos_settings_doc is not None and posnext_supports_customer_phone_policy():
        native_value = pos_settings_doc.get("require_customer_phone")
        native_phone_policy = int(1 if native_value is None else native_value)

    return {
        "allow_editable_selling_price": int(get_effective_rate_editability(pos_profile=pos_profile)),
        "allow_editing_posting_date": int(
            get_effective_posting_date_editability(pos_profile=pos_profile)
        ),
        "require_customer_phone": int(require_customer_phone),
        "customer_phone_policy_source": get_customer_phone_policy_source(),
        "posnext_require_customer_phone": native_phone_policy,
        "processedge_fallback_require_customer_phone": int(fallback_phone_policy),
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
RETAILEDGE_EXPENSE_DOCTYPE = "RetailEdge Cashier Expense"
RETAILEDGE_CATEGORY_DOCTYPE = "RetailEdge Expense Category"
RETAILEDGE_CAPABILITY_METHOD = "retailedge.pos_cashier_expense.get_pos_cashier_expense_capabilities"
RETAILEDGE_GUIDED_CONTEXT_METHOD = "retailedge.guided_cashier_expense.get_guided_cashier_expense_context"
RETAILEDGE_CATEGORY_SEARCH_METHOD = "retailedge.guided_cashier_expense.search_guided_expense_categories"
RETAILEDGE_CREATE_METHOD = "retailedge.pos_cashier_expense.create_pos_cashier_expense"
RETAILEDGE_LEGACY_CONTEXT_METHOD = "retailedge.api.get_cashier_expense_entry_context"


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


def _legacy_retailedge_available():
    return bool(
        RETAILEDGE_APP in frappe.get_installed_apps()
        and frappe.db.exists("DocType", RETAILEDGE_EXPENSE_DOCTYPE)
        and frappe.db.exists("DocType", RETAILEDGE_CATEGORY_DOCTYPE)
    )


def _legacy_pos_operational_submit_authorized(context=None):
    """Allow the cashier's own active POS shift to submit a legacy till expense.

    Older RetailEdge sites can have stale DocType submit permissions even though
    the user is the active cashier for the POS opening shift. This is a narrow
    operational authorization, not a general permission bypass: the user must
    own the active opening shift and still have create permission on the expense.
    """
    user = frappe.session.user
    if not user or user == "Guest":
        return False

    context = context or {}
    cashier = str(context.get("cashier") or context.get("user") or "").strip()
    if cashier and cashier != user:
        return False

    shift = str(context.get("linked_pos_opening_shift") or "").strip()
    if not shift or not frappe.db.exists("DocType", "POS Opening Shift"):
        return False
    if not frappe.db.exists("POS Opening Shift", shift):
        return False

    shift_meta = frappe.get_meta("POS Opening Shift")
    if shift_meta.has_field("user"):
        shift_user = str(frappe.db.get_value("POS Opening Shift", shift, "user") or "").strip()
        if shift_user and shift_user != user:
            return False

    context_profile = str(context.get("pos_profile") or "").strip()
    if context_profile and shift_meta.has_field("pos_profile"):
        shift_profile = str(
            frappe.db.get_value("POS Opening Shift", shift, "pos_profile") or ""
        ).strip()
        if shift_profile and shift_profile != context_profile:
            return False

    if shift_meta.has_field("status"):
        status = str(frappe.db.get_value("POS Opening Shift", shift, "status") or "").strip()
        if status and status.lower() != "open":
            return False

    return True


def _legacy_cashier_expense_bridge_context(pos_profile=None, opening_shift=None):
    """Compatibility bridge for pre-EdgeSuite RetailEdge installations.

    The extension owns only the POS presentation layer. RetailEdge's existing
    DocType controller remains authoritative for cashier, company, branch,
    POS shift, account resolution, cash availability, validation and submit.
    """
    context_method = _get_retailedge_method(RETAILEDGE_LEGACY_CONTEXT_METHOD)
    if not _legacy_retailedge_available() or not context_method:
        return {
            "available": 0,
            "enabled": 0,
            "show_action": 0,
            "ready": 0,
            "bridge_mode": "unavailable",
            "ui_mode": "posnext_extension",
            "requires_edgesuite": 0,
            "reason": _("RetailEdge is not installed or Cashier Expense is unavailable."),
            "categories": [],
            "guided": {},
        }

    context = context_method() or {}
    settings = context.get("settings") or {}
    blockers = []

    can_create = bool(frappe.has_permission(RETAILEDGE_EXPENSE_DOCTYPE, "create"))
    can_submit = bool(frappe.has_permission(RETAILEDGE_EXPENSE_DOCTYPE, "submit"))
    operational_submit = _legacy_pos_operational_submit_authorized(context)
    if not can_create:
        blockers.append(_("You do not have permission to create Cashier Expenses."))
    if not can_submit and not operational_submit:
        blockers.append(
            _(
                "You are not authorised to submit Cashier Expenses for the active POS shift."
            )
        )

    resolved_profile = str(context.get("pos_profile") or "").strip()
    resolved_shift = str(context.get("linked_pos_opening_shift") or "").strip()
    if pos_profile and resolved_profile and str(pos_profile).strip() != resolved_profile:
        blockers.append(_("The active POS Profile does not match the RetailEdge cashier context."))
    if opening_shift and resolved_shift and str(opening_shift).strip() != resolved_shift:
        blockers.append(_("The active POS Opening Shift does not match the RetailEdge cashier context."))

    require_open_shift = bool(
        frappe.utils.cint(settings.get("require_open_shift_for_cashier_expense", 1))
    )
    allow_without_cash_account = bool(
        frappe.utils.cint(settings.get("allow_cashier_expense_without_cash_account", 0))
    )
    if require_open_shift and not resolved_shift:
        blockers.append(_("Open a POS shift before recording a Cashier Expense."))
    if not allow_without_cash_account and not context.get("payment_account"):
        blockers.append(_("RetailEdge could not resolve the cash payment account for this shift."))
    if not context.get("company"):
        blockers.append(_("RetailEdge could not resolve the company for this cashier."))

    guided_context = {
        "cashier": context.get("cashier") or context.get("user") or frappe.session.user,
        "company": context.get("company") or "",
        "branch": context.get("branch") or "",
        "pos_profile": resolved_profile,
        "opening_shift": resolved_shift,
        "payment_account": context.get("payment_account") or "",
        "cost_center": context.get("cost_center") or "",
        "available_cash": frappe.utils.flt(
            context.get("available_shift_cash_before_expense")
        ),
        "opening_cash": frappe.utils.flt(context.get("shift_opening_cash_amount")),
        "cash_sales": frappe.utils.flt(context.get("shift_cash_sales_amount")),
        "prior_expenses": frappe.utils.flt(context.get("prior_shift_expense_amount")),
        "cash_control_message": context.get("cash_control_message") or "",
    }

    company = str(guided_context.get("company") or "").strip()
    return {
        "available": 1,
        "enabled": 1,
        "show_action": 1 if can_create else 0,
        "ready": 0 if blockers else 1,
        "bridge_mode": "legacy_retailedge",
        "ui_mode": "posnext_extension",
        "requires_edgesuite": 0,
        "posting_mode": "RetailEdge Native",
        "reason": blockers[0] if blockers else "",
        "categories": _search_legacy_cashier_expense_categories(
            txt="",
            company=company or None,
            limit=20,
        )
        if can_create
        else [],
        "guided": {
            "title": _("Record Cashier Expense"),
            "subtitle": _(
                "Record cash leaving the active POS till using the installed RetailEdge workflow."
            ),
            "ready": not blockers,
            "blocking_reasons": blockers,
            "defaults": {
                "expense_category": "",
                "amount": "",
                "description": "",
                "expense_date": frappe.utils.nowdate(),
            },
            "context": guided_context,
            "capabilities": {
                "allow_expense_date_edit": bool(
                    frappe.utils.cint(settings.get("allow_cashier_expense_date_edit", 0))
                ),
                "posting_mode": "RetailEdge Native",
                "pos_integration_enabled": True,
                "native_form_fallback": True,
                "legacy_backend": True,
                "submit_permission": can_submit,
                "operational_submit_authorized": operational_submit,
            },
        },
    }


def _search_legacy_cashier_expense_categories(txt="", company=None, limit=20):
    if not _legacy_retailedge_available():
        return []
    if not frappe.has_permission(RETAILEDGE_EXPENSE_DOCTYPE, "create"):
        frappe.throw(
            _("You do not have permission to create Cashier Expenses."),
            frappe.PermissionError,
        )

    limit = max(1, min(frappe.utils.cint(limit) or 20, 50))
    filters = [[RETAILEDGE_CATEGORY_DOCTYPE, "is_active", "=", 1]]
    if txt:
        filters.append(
            [RETAILEDGE_CATEGORY_DOCTYPE, "category_name", "like", f"%{txt}%"]
        )

    or_filters = None
    if company:
        or_filters = [
            [RETAILEDGE_CATEGORY_DOCTYPE, "company", "=", company],
            [RETAILEDGE_CATEGORY_DOCTYPE, "company", "is", "not set"],
        ]

    rows = frappe.get_list(
        RETAILEDGE_CATEGORY_DOCTYPE,
        filters=filters,
        or_filters=or_filters,
        fields=["name", "category_name", "category_code", "description"],
        order_by="category_name asc",
        limit_page_length=limit,
    )
    return [
        {
            "value": row.name,
            "label": row.category_name or row.name,
            "description": row.description
            or (_("Code {0}").format(row.category_code) if row.category_code else ""),
        }
        for row in rows
    ]


def _coerce_bridge_values(values):
    if not values:
        return {}
    if isinstance(values, str):
        values = frappe.parse_json(values)
    if isinstance(values, frappe._dict):
        return dict(values)
    if isinstance(values, dict):
        return dict(values)
    frappe.throw(_("Invalid Cashier Expense values."))
    return {}


def _legacy_expense_result(doc, *, idempotent=False):
    return {
        "idempotent": bool(idempotent),
        "doctype": doc.doctype,
        "name": doc.name,
        "docstatus": frappe.utils.cint(doc.docstatus),
        "expense_status": getattr(doc, "expense_status", None),
        "ledger_status": getattr(doc, "ledger_status", None),
        "cash_movement_status": getattr(doc, "cash_movement_status", None),
        "posting_mode": getattr(doc, "posting_mode_applied", None) or "RetailEdge Native",
        "posting_reference_type": getattr(doc, "posting_reference_type", None),
        "posting_reference": getattr(doc, "posting_reference", None),
        "company": getattr(doc, "company", None),
        "branch": getattr(doc, "branch", None),
        "pos_profile": getattr(doc, "pos_profile", None),
        "opening_shift": getattr(doc, "linked_pos_opening_shift", None),
        "amount": frappe.utils.flt(getattr(doc, "amount", 0)),
        "user_message": getattr(doc, "user_message", None),
        "bridge_mode": "legacy_retailedge",
    }


def _create_legacy_retailedge_cashier_expense(values=None):
    if not _legacy_retailedge_available():
        frappe.throw(_("RetailEdge Cashier Expense is unavailable on this site."))
    if not frappe.has_permission(RETAILEDGE_EXPENSE_DOCTYPE, "create"):
        frappe.throw(
            _("You do not have permission to create Cashier Expenses."),
            frappe.PermissionError,
        )

    legacy_context_method = _get_retailedge_method(RETAILEDGE_LEGACY_CONTEXT_METHOD)
    legacy_context = legacy_context_method() if legacy_context_method else {}
    can_submit = bool(frappe.has_permission(RETAILEDGE_EXPENSE_DOCTYPE, "submit"))
    operational_submit = _legacy_pos_operational_submit_authorized(legacy_context)
    if not can_submit and not operational_submit:
        frappe.throw(
            _(
                "You are not authorised to submit Cashier Expenses for the active POS shift."
            ),
            frappe.PermissionError,
        )

    values = _coerce_bridge_values(values)
    category = str(values.get("expense_category") or "").strip()
    if not category:
        frappe.throw(_("Expense Category is required."))
    if not frappe.db.exists(RETAILEDGE_CATEGORY_DOCTYPE, category):
        frappe.throw(_("Expense Category {0} does not exist.").format(category))
    if not frappe.has_permission(RETAILEDGE_CATEGORY_DOCTYPE, "read", doc=category):
        frappe.throw(
            _("You do not have permission to use Expense Category {0}.").format(category),
            frappe.PermissionError,
        )
    if not frappe.utils.cint(
        frappe.db.get_value(RETAILEDGE_CATEGORY_DOCTYPE, category, "is_active")
    ):
        frappe.throw(_("Expense Category {0} is inactive.").format(category))

    amount = frappe.utils.flt(values.get("amount"))
    if amount <= 0:
        frappe.throw(_("Amount must be greater than zero."))

    meta = frappe.get_meta(RETAILEDGE_EXPENSE_DOCTYPE)
    request_id = str(values.get("client_request_id") or "").strip()
    if request_id and meta.has_field("client_request_id"):
        existing_name = frappe.db.get_value(
            RETAILEDGE_EXPENSE_DOCTYPE,
            {"client_request_id": request_id},
            "name",
        )
        if existing_name:
            existing = frappe.get_doc(RETAILEDGE_EXPENSE_DOCTYPE, existing_name)
            if not existing.has_permission("read"):
                frappe.throw(
                    _("You do not have access to the existing Cashier Expense."),
                    frappe.PermissionError,
                )
            return _legacy_expense_result(existing, idempotent=True)

    settings = (legacy_context or {}).get("settings") or {}

    doc = frappe.new_doc(RETAILEDGE_EXPENSE_DOCTYPE)
    doc.expense_category = category
    doc.amount = amount
    if values.get("description"):
        doc.description = str(values.get("description")).strip()
    if values.get("expense_date") and frappe.utils.cint(
        settings.get("allow_cashier_expense_date_edit", 0)
    ):
        doc.expense_date = frappe.utils.getdate(values.get("expense_date"))

    if request_id and meta.has_field("client_request_id"):
        doc.client_request_id = request_id
    if meta.has_field("entry_source"):
        doc.entry_source = "POSNext"
    if meta.has_field("cash_source"):
        doc.cash_source = "POS Till"
    if meta.has_field("cash_movement_status"):
        doc.cash_movement_status = "Disbursed"

    # The installed RetailEdge controller remains authoritative: before_validate
    # resolves cashier/company/branch/POS/account context and validates available
    # till cash. The extension supplies only the cashier-entered fields.
    doc.insert()
    if not can_submit and operational_submit:
        # Purpose-built POS endpoint: the user has already been constrained to
        # their own active opening shift above. Ignore only the stale DocType
        # submit matrix; RetailEdge's controller validations still run normally.
        doc.flags.ignore_permissions = True
    doc.submit()
    return _legacy_expense_result(
        frappe.get_doc(RETAILEDGE_EXPENSE_DOCTYPE, doc.name),
        idempotent=False,
    )


@frappe.whitelist()
def get_cashier_expense_bridge_context(pos_profile=None, opening_shift=None):
    """Return a permission-aware RetailEdge POS expense context.

    New RetailEdge installations use the dedicated POS bridge. Pre-EdgeSuite
    installations fall back to the original RetailEdge Cashier Expense controller
    while the POSNext extension owns only the modal presentation.
    """
    capability_method = _get_retailedge_method(RETAILEDGE_CAPABILITY_METHOD)
    if not capability_method:
        return _legacy_cashier_expense_bridge_context(
            pos_profile=pos_profile,
            opening_shift=opening_shift,
        )

    capabilities = capability_method(
        pos_profile=pos_profile,
        opening_shift=opening_shift,
    ) or {}

    response = {
        "available": 1,
        **capabilities,
        "bridge_mode": "modern_retailedge",
        "ui_mode": "posnext_extension",
        "requires_edgesuite": 0,
        "categories": [],
        "guided": {},
    }

    if not capabilities.get("show_action") or not capabilities.get("ready"):
        return response

    guided_method = _get_retailedge_method(RETAILEDGE_GUIDED_CONTEXT_METHOD)
    category_method = _get_retailedge_method(RETAILEDGE_CATEGORY_SEARCH_METHOD)
    if not guided_method or not category_method:
        legacy = _legacy_cashier_expense_bridge_context(
            pos_profile=pos_profile,
            opening_shift=opening_shift,
        )
        if legacy.get("available"):
            legacy["enabled"] = capabilities.get("enabled", legacy.get("enabled", 1))
            legacy["show_action"] = capabilities.get(
                "show_action", legacy.get("show_action", 1)
            )
            legacy["posting_mode"] = capabilities.get(
                "posting_mode", legacy.get("posting_mode")
            )
            return legacy
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
    method = _get_retailedge_method(RETAILEDGE_CATEGORY_SEARCH_METHOD)
    if method:
        return method(txt=txt or "", company=company or None, limit=limit)
    return _search_legacy_cashier_expense_categories(
        txt=txt or "",
        company=company or None,
        limit=limit,
    )


@frappe.whitelist(methods=["POST"])
def create_retailedge_cashier_expense(values=None):
    method = _get_retailedge_method(RETAILEDGE_CREATE_METHOD)
    if method:
        return method(values=values)
    return _create_legacy_retailedge_cashier_expense(values=values)
