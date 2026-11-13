(function () {
  if (window.__processedgePosSessionCompatInstalled) {
    return;
  }

  const path = String(window.location?.pathname || "");
  if (!(path === "/pos" || path.startsWith("/pos/"))) {
    return;
  }

  if (typeof window.fetch !== "function") {
    return;
  }

  const LOGGED_USER_ENDPOINT = "/api/method/frappe.auth.get_logged_user";
  const originalFetch = window.fetch.bind(window);

  function cookieValue(name) {
    const prefix = `${name}=`;
    const row = String(document.cookie || "")
      .split(";")
      .map((value) => value.trim())
      .find((value) => value.startsWith(prefix));
    if (!row) return "";
    try {
      return decodeURIComponent(row.slice(prefix.length));
    } catch (_error) {
      return row.slice(prefix.length);
    }
  }

  function authenticatedSystemUserFromCookie() {
    const user = cookieValue("user_id");
    const systemUser = cookieValue("system_user");
    if (!user || user === "Guest" || systemUser !== "yes") {
      return "";
    }
    return user;
  }

  function isLoggedUserRequest(input) {
    const value = typeof input === "string" ? input : input?.url;
    if (!value) return false;
    try {
      const url = new URL(value, window.location.origin);
      return url.pathname === LOGGED_USER_ENDPOINT;
    } catch (_error) {
      return String(value).includes(LOGGED_USER_ENDPOINT);
    }
  }

  async function isAuthenticationError(response) {
    if (!response || response.ok) return false;
    try {
      const payload = await response.clone().json();
      const excType = String(payload?.exc_type || "");
      const exception = String(payload?.exception || "");
      if (excType === "AuthenticationError" || exception.includes("AuthenticationError")) {
        return true;
      }
    } catch (_error) {
      // If an authentication-shaped response cannot be inspected, fail closed.
    }
    return Number(response.status || 0) === 401;
  }

  function syntheticLoggedUserResponse(user) {
    return new Response(JSON.stringify({ message: user }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  const patchedFetch = async function (input, init) {
    if (!isLoggedUserRequest(input)) {
      return originalFetch(input, init);
    }

    try {
      const response = await originalFetch(input, init);
      if (response.ok || (await isAuthenticationError(response))) {
        return response;
      }

      const user = authenticatedSystemUserFromCookie();
      if (!user) return response;

      console.warn(
        "ProcessEdge POS compatibility: logged-user bootstrap failed without an authentication error; reusing the existing Frappe session cookie."
      );
      return syntheticLoggedUserResponse(user);
    } catch (error) {
      const user = authenticatedSystemUserFromCookie();
      if (!user) throw error;

      console.warn(
        "ProcessEdge POS compatibility: logged-user bootstrap was unavailable; reusing the existing Frappe session cookie."
      );
      return syntheticLoggedUserResponse(user);
    }
  };

  patchedFetch.__processedgePosSessionCompat = true;
  patchedFetch.__processedgePosSessionOriginal = originalFetch;
  window.fetch = patchedFetch;
  window.__processedgePosSessionCompatInstalled = true;
})();
