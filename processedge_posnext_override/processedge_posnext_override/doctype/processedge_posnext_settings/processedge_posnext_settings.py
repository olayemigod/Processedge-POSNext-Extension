import frappe
from frappe.model.document import Document

from processedge_posnext_override.overrides.pos_settings import ensure_posnext_settings_sync


class ProcessEdgePOSNextSettings(Document):
    def validate(self):
        self.editable_price_roles = (self.editable_price_roles or "").strip()
        if not self.get("enable_edgesuite_receipt_printing"):
            self.auto_print_edgesuite_receipts = 0

    def on_update(self):
        ensure_posnext_settings_sync()
