from __future__ import annotations

POS_PAGE_SCRIPT = "/assets/processedge_posnext_override/js/processedge_posnext_override.js"
_SCRIPT_TAG = f'<script src="{POS_PAGE_SCRIPT}"></script>'


def inject_pos_page_script(response=None, request=None):
    """Inject the ProcessEdge POS bridge into POSNext's standalone Vite page.

    POSNext serves /pos from a generated Vite HTML entry instead of Frappe's
    standard website base template, so web_include_js can be present in
    assets_json without being emitted as a script tag on that page.
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

    if not html or POS_PAGE_SCRIPT in html:
        return

    closing_body = html.lower().rfind("</body>")
    if closing_body < 0:
        return

    html = html[:closing_body] + "\n" + _SCRIPT_TAG + "\n" + html[closing_body:]
    response.set_data(html)
