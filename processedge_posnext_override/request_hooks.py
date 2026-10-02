from __future__ import annotations

POS_PAGE_SCRIPT = "/assets/processedge_posnext_override/js/processedge_posnext_override.js"
EDGE_SUITE_PRINT_ASSET = "edgeui_print.bundle.js"


def _resolve_edge_suite_print_script() -> str:
    """Resolve EdgeSuite's hashed lightweight print bundle when installed.

    The POS page is a standalone Vite document and does not inherit Desk's
    app_include_js assets. Resolve the built bundle from Frappe's assets.json
    instead of hard-coding a build hash.
    """

    try:
        import frappe
        from frappe.utils import get_assets_json
    except ImportError:
        return ""

    try:
        if "edgesuite_ui" not in frappe.get_installed_apps():
            return ""
        resolved = str((get_assets_json() or {}).get(EDGE_SUITE_PRINT_ASSET) or "").strip()
    except Exception:
        return ""

    if not resolved:
        return ""
    return resolved if resolved.startswith("/") else f"/{resolved}"


def _script_tag(source: str) -> str:
    return f'<script src="{source}"></script>'


def inject_pos_page_script(response=None, request=None):
    """Inject ProcessEdge's POS bridge and optional EdgeSuite print runtime.

    POSNext serves /pos from a generated Vite HTML entry instead of Frappe's
    standard website base template, so web_include_js can be present in
    assets_json without being emitted as a script tag on that page.

    When EdgeSuite UI is installed and its lightweight print bundle has been
    built, inject it before the ProcessEdge bridge. Other website routes are
    untouched and sites without EdgeSuite keep the existing POS behavior.
    """

    if response is None or request is None:
        return

    if str(getattr(request, "method", "GET") or "GET").upper() != "GET":
        return

    path = str(getattr(request, "path", "") or "")
    if not (path == "/pos" or path.startswith("/pos/")):
        return

    if int(getattr(response, "status_code", 200) or 200) != 200:
        return

    if str(getattr(response, "mimetype", "") or "").lower() != "text/html":
        return

    try:
        html = response.get_data(as_text=True)
    except Exception:
        return

    if not html:
        return

    sources: list[str] = []
    edge_print_script = _resolve_edge_suite_print_script()
    if edge_print_script and edge_print_script not in html:
        sources.append(edge_print_script)
    if POS_PAGE_SCRIPT not in html:
        sources.append(POS_PAGE_SCRIPT)
    if not sources:
        return

    closing_body = html.lower().rfind("</body>")
    if closing_body < 0:
        return

    tags = "\n".join(_script_tag(source) for source in sources)
    html = html[:closing_body] + "\n" + tags + "\n" + html[closing_body:]
    response.set_data(html)
