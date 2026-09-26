from __future__ import annotations

from processedge_posnext_override.request_hooks import POS_PAGE_SCRIPT, inject_pos_page_script


class DummyRequest:
    def __init__(self, path="/pos/", method="GET"):
        self.path = path
        self.method = method


class DummyResponse:
    def __init__(
        self,
        body="<html><body><div id='app'></div></body></html>",
        mimetype="text/html",
        status_code=200,
    ):
        self._body = body
        self.mimetype = mimetype
        self.status_code = status_code

    def get_data(self, as_text=False):
        return self._body if as_text else self._body.encode()

    def set_data(self, value):
        self._body = value


def test_injects_bridge_into_pos_html_once():
    response = DummyResponse()

    inject_pos_page_script(response=response, request=DummyRequest())
    inject_pos_page_script(response=response, request=DummyRequest())

    assert response._body.count(POS_PAGE_SCRIPT) == 1
    assert response._body.index(POS_PAGE_SCRIPT) < response._body.lower().index("</body>")


def test_injects_pos_subpaths_but_not_other_pages():
    pos_response = DummyResponse()
    inject_pos_page_script(response=pos_response, request=DummyRequest("/pos/checkout"))
    assert POS_PAGE_SCRIPT in pos_response._body

    desk_response = DummyResponse()
    inject_pos_page_script(response=desk_response, request=DummyRequest("/app"))
    assert POS_PAGE_SCRIPT not in desk_response._body


def test_skips_non_html_non_get_and_error_responses():
    json_response = DummyResponse(mimetype="application/json")
    inject_pos_page_script(response=json_response, request=DummyRequest())
    assert POS_PAGE_SCRIPT not in json_response._body

    post_response = DummyResponse()
    inject_pos_page_script(response=post_response, request=DummyRequest(method="POST"))
    assert POS_PAGE_SCRIPT not in post_response._body

    error_response = DummyResponse(status_code=500)
    inject_pos_page_script(response=error_response, request=DummyRequest())
    assert POS_PAGE_SCRIPT not in error_response._body
