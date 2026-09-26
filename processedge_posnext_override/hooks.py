app_name = "processedge_posnext_override"
app_title = "ProcessEdge POSNext Override"
app_publisher = "ProcessEdge Solutions"
app_description = "POSNext overrides for editable price and posting date control"
app_email = "processedgeng@gmail.com"
app_license = "MIT"

required_apps = ["erpnext", "pos_next"]

app_include_js = [
    "processedge_posnext_override.bundle.js",
]

web_include_js = [
    "processedge_posnext_override.bundle.js",
]

fixtures = []

after_install = "processedge_posnext_override.install.after_install"
after_migrate = "processedge_posnext_override.install.after_migrate"

after_request = ["processedge_posnext_override.request_hooks.inject_pos_page_script"]

doc_events = {
    "POS Settings": {
        "validate": "processedge_posnext_override.overrides.pos_settings.apply_app_settings_to_doc",
    },
    "Sales Invoice": {
        "validate": "processedge_posnext_override.overrides.sales_invoice.validate_pos_invoice_posting_date",
    },
}

override_whitelisted_methods = {
    "pos_next.pos_next.doctype.pos_settings.pos_settings.get_pos_settings": "processedge_posnext_override.overrides.pos_settings.get_pos_settings_override",
}
