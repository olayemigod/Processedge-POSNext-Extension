import frappe
from frappe import _
from frappe.utils import getdate, nowdate

from processedge_posnext_override.overrides.pos_settings import (
    get_effective_posting_date_editability,
)


def validate_pos_invoice_posting_date(doc, method=None):
    if not getattr(doc, "is_pos", 0):
        return

    posting_date = getattr(doc, "posting_date", None)
    if not posting_date:
        return

    if get_effective_posting_date_editability(
        pos_profile=getattr(doc, "pos_profile", None)
    ):
        return

    if getdate(posting_date) != getdate(nowdate()):
        frappe.throw(
            _("Editing Posting Date on POS is disabled in ProcessEdge POSNext Settings."),
            title=_("Posting Date Not Allowed"),
        )
