from __future__ import annotations

from html.parser import HTMLParser

POS_SESSION_COMPAT_SCRIPT = "/assets/processedge_posnext_override/js/processedge_pos_session_compat.js"
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


class _ScriptSourceCollector(HTMLParser):
    """Collect actual script src attributes, never inline boot asset references."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.sources: set[str] = set()

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag.lower() != "script":
            return
        for name, value in attrs:
            if name.lower() == "src" and value:
                self.sources.add(value.strip())


def _existing_script_sources(html: str) -> set[str]:
    parser = _ScriptSourceCollector()
    parser.feed(html)
    return parser.sources


def _script_tag(source: str) -> str:
    return f'<script src="{source}"></script>'


def inject_pos_page_script(response=None, request=None):
    """Inject ProcessEdge POS compatibility, printing runtime and bridge assets.

    POSNext serves /pos from a generated Vite HTML entry instead of Frappe's
    standard website base template, so web_include_js can be present in
    assets_json without being emitted as a script tag on that page.

    The session-compatibility script is a classic synchronous script. It must be
    emitted before the deferred POSNext module gets a chance to initialize so
    authenticated Frappe sessions survive non-auth startup read failures on the
    pinned POSNext runtime. EdgeSuite's print runtime and the main ProcessEdge
    POS bridge follow it. Other website routes are untouched.
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

    # The standalone POS Vite HTML can include the hashed asset path in
    # inline boot JSON without executing it. Checking source in html
    # incorrectly treats that string as a loaded script and leaves
    # window.EdgeSuitePrint undefined even when the bundle is built.
    loaded_scripts = _existing_script_sources(html)
    sources: list[str] = []
    if POS_SESSION_COMPAT_SCRIPT not in loaded_scripts:
        sources.append(POS_SESSION_COMPAT_SCRIPT)

    edge_print_script = _resolve_edge_suite_print_script()
    if edge_print_script and edge_print_script not in loaded_scripts:
        sources.append(edge_print_script)
    if POS_PAGE_SCRIPT not in loaded_scripts:
        sources.append(POS_PAGE_SCRIPT)
    if not sources:
        return

    closing_body = html.lower().rfind("</body>")
    if closing_body < 0:
        return

    tags = "\n".join(_script_tag(source) for source in sources)
    html = html[:closing_body] + "\n" + tags + "\n" + html[closing_body:]
    response.set_data(html)
