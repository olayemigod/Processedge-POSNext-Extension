(function () {
  if (window.processedgePosnextOverrideInitialized) {
    return;
  }
  window.processedgePosnextOverrideInitialized = true;

  const STATE = {
    settings: null,
    postingDate: null,
    observer: null,
    cashierExpense: {
      bridge: null,
      selectedCategory: null,
      requestId: null,
      searchTimer: null,
    },
  };

  function isPOSPage() {
    return window.location.pathname === "/pos" || window.location.pathname.startsWith("/pos/");
  }

  function getToday() {
    return new Date().toISOString().slice(0, 10);
  }

  const CSRF_TOKEN_ENDPOINT = "/api/method/pos_next.api.utilities.get_csrf_token";
  const WRITE_METHODS = new Set([
    "processedge_posnext_override.api.create_retailedge_cashier_expense",
  ]);

  function apiArgs(args) {
    const params = new URLSearchParams();
    Object.entries(args || {}).forEach(([key, value]) => {
      if (value === undefined || value === null) return;
      params.set(key, typeof value === "object" ? JSON.stringify(value) : String(value));
    });
    return params;
  }

  async function parseAPIResponse(response) {
    const contentType = response.headers.get("content-type") || "";
    let payload = null;
    if (contentType.includes("application/json")) {
      try {
        payload = await response.json();
      } catch (_error) {
        payload = null;
      }
    }

    if (!response.ok) {
      const message =
        (payload && (payload.exception || payload._error_message || payload.message)) ||
        `Request failed with status ${response.status}`;
      throw new Error(typeof message === "string" ? message : JSON.stringify(message));
    }

    return payload && Object.prototype.hasOwnProperty.call(payload, "message")
      ? payload.message
      : payload;
  }

  function validCSRFToken(token) {
    return typeof token === "string" && token && token !== "{{ csrf_token }}";
  }

  async function ensureCSRFToken() {
    if (validCSRFToken(window.csrf_token)) {
      return window.csrf_token;
    }

    const response = await window.fetch(CSRF_TOKEN_ENDPOINT, {
      method: "GET",
      credentials: "include",
      cache: "no-store",
      headers: {
        Accept: "application/json",
        "X-Frappe-Site-Name": window.location.hostname,
      },
    });
    const data = await parseAPIResponse(response);
    const token = data && data.csrf_token ? data.csrf_token : null;
    if (!validCSRFToken(token)) {
      throw new Error("Unable to obtain a CSRF token for the ProcessEdge POS bridge.");
    }
    window.csrf_token = token;
    return token;
  }

  async function callAPI(method, args) {
    const endpoint = `/api/method/${method}`;
    const params = apiArgs(args);

    if (!WRITE_METHODS.has(method)) {
      const query = params.toString();
      const response = await window.fetch(query ? `${endpoint}?${query}` : endpoint, {
        method: "GET",
        credentials: "include",
        cache: "no-store",
        headers: {
          Accept: "application/json",
          "X-Frappe-Site-Name": window.location.hostname,
        },
      });
      return parseAPIResponse(response);
    }

    const csrfToken = await ensureCSRFToken();
    const response = await window.fetch(endpoint, {
      method: "POST",
      credentials: "include",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "X-Frappe-CSRF-Token": csrfToken,
        "X-Frappe-Site-Name": window.location.hostname,
      },
      body: params.toString(),
    });
    return parseAPIResponse(response);
  }

  async function loadSettings() {
    try {
      const data = await callAPI("processedge_posnext_override.api.get_pos_override_settings");
      STATE.settings = data || {};
      STATE.postingDate = data && data.posting_date ? data.posting_date : getToday();
    } catch (error) {
      console.warn("ProcessEdge POSNext Override: failed to load settings", error);
      STATE.settings = {
        allow_editable_selling_price: 0,
        allow_editing_posting_date: 0,
      };
      STATE.postingDate = getToday();
    }
  }


  async function loadCashierExpenseBridge() {
    try {
      const bridge = await callAPI(
        "processedge_posnext_override.api.get_cashier_expense_bridge_context",
        { pos_profile: STATE.settings && STATE.settings.pos_profile ? STATE.settings.pos_profile : null }
      );
      STATE.cashierExpense.bridge = bridge || { available: 0, enabled: 0, show_action: 0, ready: 0 };
    } catch (error) {
      console.warn("ProcessEdge POSNext Override: failed to load Cashier Expense bridge", error);
      STATE.cashierExpense.bridge = { available: 0, enabled: 0, show_action: 0, ready: 0 };
    }
  }

  function makeRequestId() {
    if (window.crypto && typeof window.crypto.randomUUID === "function") {
      return window.crypto.randomUUID();
    }
    return "retailedge-pos-" + Date.now() + "-" + Math.random().toString(36).slice(2, 12);
  }

  function normalizeError(error) {
    if (!error) return "Unable to record Cashier Expense.";
    if (typeof error === "string") return error;
    if (error.message) return error.message;
    if (error.exc) return String(error.exc);
    return "Unable to record Cashier Expense.";
  }

  function removeCashierExpenseActions() {
    document.querySelectorAll("[data-processedge-cashier-expense-action]").forEach((node) => node.remove());
  }

  function createCashierExpenseSidebarButton(sidebar) {
    if (!sidebar || sidebar.querySelector("[data-processedge-cashier-expense-action]")) {
      return;
    }

    const button = document.createElement("button");
    button.type = "button";
    button.setAttribute("data-processedge-cashier-expense-action", "sidebar");
    button.title = "Cashier Expense";
    button.setAttribute("aria-label", "Cashier Expense");
    button.className =
      "w-12 h-12 rounded-lg flex items-center justify-center transition-all relative group text-emerald-700 hover:bg-emerald-50 hover:text-emerald-800";
    button.innerHTML = [
      '<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">',
      '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8c-2.761 0-5 1.343-5 3s2.239 3 5 3 5 1.343 5 3-2.239 3-5 3m0-12V6m0 14v-2m9-6a9 9 0 11-18 0 9 9 0 0118 0z"></path>',
      "</svg>",
      '<div class="absolute start-full ms-2 px-2 py-1 bg-gray-900 text-white text-xs rounded opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none whitespace-nowrap z-50">Cashier Expense</div>',
    ].join("");
    button.addEventListener("click", openCashierExpenseDialog);

    const settingsButton = Array.from(sidebar.querySelectorAll("button")).find(
      (item) => (item.getAttribute("title") || "").toLowerCase().includes("setting")
    );
    if (settingsButton) {
      sidebar.insertBefore(button, settingsButton);
    } else {
      sidebar.appendChild(button);
    }
  }

  function createCashierExpenseFloatingButton() {
    if (document.querySelector("[data-processedge-cashier-expense-action='floating']")) {
      return;
    }

    const button = document.createElement("button");
    button.type = "button";
    button.setAttribute("data-processedge-cashier-expense-action", "floating");
    button.setAttribute("aria-label", "Cashier Expense");
    button.title = "Cashier Expense";
    button.style.cssText = [
      "position:fixed",
      "right:20px",
      "bottom:24px",
      "z-index:9000",
      "display:flex",
      "align-items:center",
      "gap:8px",
      "height:44px",
      "padding:0 14px",
      "border:1px solid #a7f3d0",
      "border-radius:14px",
      "background:#ecfdf5",
      "color:#047857",
      "font-weight:700",
      "font-size:13px",
      "box-shadow:0 10px 30px rgba(15,23,42,.16)",
      "cursor:pointer",
    ].join(";");
    button.innerHTML = [
      '<svg width="18" height="18" fill="none" stroke="currentColor" viewBox="0 0 24 24">',
      '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8c-2.761 0-5 1.343-5 3s2.239 3 5 3 5 1.343 5 3-2.239 3-5 3m0-12V6m0 14v-2m9-6a9 9 0 11-18 0 9 9 0 0118 0z"></path>',
      "</svg>",
      "<span>Cashier Expense</span>",
    ].join("");
    button.addEventListener("click", openCashierExpenseDialog);
    document.body.appendChild(button);
  }

  function injectCashierExpenseAction() {
    const bridge = STATE.cashierExpense.bridge;
    if (!bridge || !bridge.available || !bridge.enabled || !bridge.show_action) {
      removeCashierExpenseActions();
      return;
    }

    const sidebar = Array.from(document.querySelectorAll("div")).find((node) => {
      if (!node.classList || !node.classList.contains("w-16")) return false;
      if (!node.classList.contains("lg:flex")) return false;
      return node.querySelectorAll("button").length >= 4;
    });

    if (sidebar) {
      createCashierExpenseSidebarButton(sidebar);
      const floating = document.querySelector("[data-processedge-cashier-expense-action='floating']");
      if (floating && window.innerWidth >= 1024) floating.remove();
    }

    if (!sidebar || window.innerWidth < 1024) {
      createCashierExpenseFloatingButton();
    }
  }

  async function searchCashierExpenseCategories(term) {
    const bridge = STATE.cashierExpense.bridge || {};
    const company =
      bridge.guided && bridge.guided.context ? bridge.guided.context.company || null : null;
    try {
      const rows = await callAPI(
        "processedge_posnext_override.api.search_cashier_expense_categories",
        { txt: term || "", company, limit: 20 }
      );
      return Array.isArray(rows) ? rows : [];
    } catch (error) {
      console.warn("ProcessEdge POSNext Override: category search failed", error);
      return [];
    }
  }

  function showPOSAlert(message, indicator) {
    if (window.frappe && typeof window.frappe.show_alert === "function") {
      window.frappe.show_alert({ message, indicator: indicator || "green" }, 5);
      return;
    }
    console.info(message);
  }

  function closeCashierExpenseDialog() {
    const overlay = document.querySelector("[data-processedge-cashier-expense-dialog]");
    if (overlay) overlay.remove();
    STATE.cashierExpense.selectedCategory = null;
    STATE.cashierExpense.requestId = null;
    if (STATE.cashierExpense.searchTimer) {
      clearTimeout(STATE.cashierExpense.searchTimer);
      STATE.cashierExpense.searchTimer = null;
    }
  }

  function renderCategoryResults(container, rows, input) {
    container.innerHTML = "";
    if (!rows || !rows.length) {
      const empty = document.createElement("div");
      empty.textContent = "No matching expense categories";
      empty.style.cssText = "padding:10px 12px;color:#64748b;font-size:12px;";
      container.appendChild(empty);
      container.style.display = "block";
      return;
    }

    rows.forEach((row) => {
      const item = document.createElement("button");
      item.type = "button";
      item.style.cssText =
        "display:block;width:100%;text-align:left;padding:9px 12px;border:0;background:#fff;cursor:pointer;";
      const label = document.createElement("div");
      label.textContent = row.label || row.value;
      label.style.cssText = "font-size:13px;font-weight:600;color:#0f172a;";
      item.appendChild(label);
      if (row.description) {
        const description = document.createElement("div");
        description.textContent = row.description;
        description.style.cssText = "font-size:11px;color:#64748b;margin-top:2px;";
        item.appendChild(description);
      }
      item.addEventListener("mouseenter", () => {
        item.style.background = "#f8fafc";
      });
      item.addEventListener("mouseleave", () => {
        item.style.background = "#fff";
      });
      item.addEventListener("click", () => {
        STATE.cashierExpense.selectedCategory = row.value;
        input.value = row.label || row.value;
        container.style.display = "none";
      });
      container.appendChild(item);
    });
    container.style.display = "block";
  }

  async function openCashierExpenseDialog() {
    const bridge = STATE.cashierExpense.bridge || {};
    if (!bridge.ready) {
      const reason =
        bridge.reason ||
        (bridge.guided && bridge.guided.blocking_reasons && bridge.guided.blocking_reasons[0]) ||
        "Open a valid POS shift before recording a Cashier Expense.";
      if (window.frappe && typeof window.frappe.msgprint === "function") {
        window.frappe.msgprint(reason);
      } else {
        showPOSAlert(reason, "orange");
      }
      return;
    }

    closeCashierExpenseDialog();
    STATE.cashierExpense.requestId = makeRequestId();

    const guided = bridge.guided || {};
    const context = guided.context || {};
    const capabilities = guided.capabilities || {};
    const overlay = document.createElement("div");
    overlay.setAttribute("data-processedge-cashier-expense-dialog", "1");
    overlay.style.cssText =
      "position:fixed;inset:0;z-index:12000;background:rgba(15,23,42,.55);display:flex;align-items:center;justify-content:center;padding:16px;";

    const card = document.createElement("div");
    card.style.cssText =
      "width:min(480px,100%);max-height:92vh;overflow:auto;background:#fff;border-radius:18px;box-shadow:0 24px 80px rgba(15,23,42,.30);";
    overlay.appendChild(card);

    const header = document.createElement("div");
    header.style.cssText =
      "display:flex;align-items:flex-start;justify-content:space-between;padding:18px 20px 14px;border-bottom:1px solid #e2e8f0;";
    const headingWrap = document.createElement("div");
    const heading = document.createElement("div");
    heading.textContent = "Cashier Expense";
    heading.style.cssText = "font-size:18px;font-weight:800;color:#0f172a;";
    const subtitle = document.createElement("div");
    subtitle.textContent = "Record cash already leaving the active POS till.";
    subtitle.style.cssText = "font-size:12px;color:#64748b;margin-top:3px;";
    headingWrap.appendChild(heading);
    headingWrap.appendChild(subtitle);
    const closeButton = document.createElement("button");
    closeButton.type = "button";
    closeButton.textContent = "×";
    closeButton.setAttribute("aria-label", "Close");
    closeButton.style.cssText =
      "border:0;background:transparent;font-size:28px;line-height:24px;color:#64748b;cursor:pointer;padding:0 4px;";
    closeButton.addEventListener("click", closeCashierExpenseDialog);
    header.appendChild(headingWrap);
    header.appendChild(closeButton);
    card.appendChild(header);

    const body = document.createElement("div");
    body.style.cssText = "padding:16px 20px 20px;";
    card.appendChild(body);

    const summary = document.createElement("div");
    summary.style.cssText =
      "display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;margin-bottom:16px;";
    [
      ["Branch", context.branch || "—"],
      ["Available Till Cash", context.available_cash !== undefined ? String(context.available_cash) : "—"],
      ["POS Profile", context.pos_profile || "—"],
      ["Posting Mode", capabilities.posting_mode || bridge.posting_mode || "Controlled Posting"],
    ].forEach(([labelText, valueText]) => {
      const box = document.createElement("div");
      box.style.cssText = "padding:9px 10px;border:1px solid #e2e8f0;border-radius:10px;background:#f8fafc;";
      const label = document.createElement("div");
      label.textContent = labelText;
      label.style.cssText = "font-size:10px;text-transform:uppercase;letter-spacing:.04em;color:#64748b;";
      const value = document.createElement("div");
      value.textContent = valueText;
      value.style.cssText = "font-size:12px;font-weight:700;color:#0f172a;margin-top:2px;overflow-wrap:anywhere;";
      box.appendChild(label);
      box.appendChild(value);
      summary.appendChild(box);
    });
    body.appendChild(summary);

    const makeField = (labelText) => {
      const field = document.createElement("div");
      field.style.cssText = "margin-bottom:13px;";
      const label = document.createElement("label");
      label.textContent = labelText;
      label.style.cssText = "display:block;font-size:12px;font-weight:700;color:#334155;margin-bottom:5px;";
      field.appendChild(label);
      body.appendChild(field);
      return field;
    };

    const categoryField = makeField("Expense Category");
    categoryField.style.position = "relative";
    const categoryInput = document.createElement("input");
    categoryInput.type = "text";
    categoryInput.autocomplete = "off";
    categoryInput.placeholder = "Search expense category";
    categoryInput.style.cssText =
      "width:100%;height:40px;border:1px solid #cbd5e1;border-radius:10px;padding:0 11px;font-size:13px;outline:none;box-sizing:border-box;";
    const categoryResults = document.createElement("div");
    categoryResults.style.cssText =
      "display:none;position:absolute;left:0;right:0;top:66px;z-index:4;max-height:190px;overflow:auto;border:1px solid #cbd5e1;border-radius:10px;background:#fff;box-shadow:0 12px 30px rgba(15,23,42,.14);";
    categoryField.appendChild(categoryInput);
    categoryField.appendChild(categoryResults);

    const initialCategories = Array.isArray(bridge.categories) ? bridge.categories : [];
    categoryInput.addEventListener("focus", () => {
      renderCategoryResults(categoryResults, initialCategories, categoryInput);
    });
    categoryInput.addEventListener("input", () => {
      STATE.cashierExpense.selectedCategory = null;
      if (STATE.cashierExpense.searchTimer) clearTimeout(STATE.cashierExpense.searchTimer);
      STATE.cashierExpense.searchTimer = setTimeout(async () => {
        const rows = await searchCashierExpenseCategories(categoryInput.value.trim());
        renderCategoryResults(categoryResults, rows, categoryInput);
      }, 250);
    });

    const amountField = makeField("Amount");
    const amountInput = document.createElement("input");
    amountInput.type = "number";
    amountInput.min = "0.01";
    amountInput.step = "0.01";
    amountInput.placeholder = "0.00";
    amountInput.style.cssText =
      "width:100%;height:40px;border:1px solid #cbd5e1;border-radius:10px;padding:0 11px;font-size:14px;outline:none;box-sizing:border-box;";
    amountField.appendChild(amountInput);

    const descriptionField = makeField("Description");
    const descriptionInput = document.createElement("textarea");
    descriptionInput.rows = 3;
    descriptionInput.placeholder = "What was this expense for?";
    descriptionInput.style.cssText =
      "width:100%;border:1px solid #cbd5e1;border-radius:10px;padding:9px 11px;font-size:13px;outline:none;resize:vertical;box-sizing:border-box;";
    descriptionField.appendChild(descriptionInput);

    let dateInput = null;
    if (capabilities.allow_expense_date_edit) {
      const dateField = makeField("Expense Date");
      dateInput = document.createElement("input");
      dateInput.type = "date";
      dateInput.value = (guided.defaults && guided.defaults.expense_date) || getToday();
      dateInput.style.cssText =
        "width:100%;height:40px;border:1px solid #cbd5e1;border-radius:10px;padding:0 11px;font-size:13px;outline:none;box-sizing:border-box;";
      dateField.appendChild(dateInput);
    }

    const errorBox = document.createElement("div");
    errorBox.style.cssText =
      "display:none;margin:4px 0 12px;padding:9px 10px;border:1px solid #fecaca;border-radius:9px;background:#fef2f2;color:#b91c1c;font-size:12px;";
    body.appendChild(errorBox);

    const footer = document.createElement("div");
    footer.style.cssText = "display:flex;justify-content:flex-end;gap:9px;margin-top:4px;";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = "Cancel";
    cancel.style.cssText =
      "height:40px;padding:0 14px;border:1px solid #cbd5e1;border-radius:10px;background:#fff;color:#334155;font-weight:700;cursor:pointer;";
    cancel.addEventListener("click", closeCashierExpenseDialog);
    const submit = document.createElement("button");
    submit.type = "button";
    submit.textContent = "Record Expense";
    submit.style.cssText =
      "height:40px;padding:0 16px;border:0;border-radius:10px;background:#047857;color:#fff;font-weight:800;cursor:pointer;";
    footer.appendChild(cancel);
    footer.appendChild(submit);
    body.appendChild(footer);

    submit.addEventListener("click", async () => {
      errorBox.style.display = "none";
      const category = STATE.cashierExpense.selectedCategory;
      const amount = Number.parseFloat(amountInput.value || "0");
      if (!category) {
        errorBox.textContent = "Select a valid Expense Category.";
        errorBox.style.display = "block";
        return;
      }
      if (!Number.isFinite(amount) || amount <= 0) {
        errorBox.textContent = "Enter an amount greater than zero.";
        errorBox.style.display = "block";
        return;
      }

      submit.disabled = true;
      cancel.disabled = true;
      submit.textContent = "Recording…";
      try {
        const values = {
          expense_category: category,
          amount,
          description: descriptionInput.value.trim(),
          client_request_id: STATE.cashierExpense.requestId,
          pos_profile: context.pos_profile || null,
          opening_shift: context.opening_shift || null,
        };
        if (dateInput && dateInput.value) values.expense_date = dateInput.value;

        const result = await callAPI(
          "processedge_posnext_override.api.create_retailedge_cashier_expense",
          { values: JSON.stringify(values) }
        );
        closeCashierExpenseDialog();
        const expenseName = result && result.name ? " " + result.name : "";
        const needsAttention = result && result.ledger_status === "Failed";
        const resultMessage =
          "Cashier Expense" +
          expenseName +
          " recorded." +
          (result && result.user_message ? " " + result.user_message : "");
        showPOSAlert(resultMessage, needsAttention ? "orange" : "green");
        await loadCashierExpenseBridge();
        injectCashierExpenseAction();
      } catch (error) {
        errorBox.textContent = normalizeError(error);
        errorBox.style.display = "block";
        submit.disabled = false;
        cancel.disabled = false;
        submit.textContent = "Record Expense";
      }
    });

    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) closeCashierExpenseDialog();
    });
    document.body.appendChild(overlay);
  }

  const INVOICE_PATCH_FIELDS = [
    ["pos_next.api.invoices.update_invoice", "data"],
    ["pos_next.api.invoices.submit_invoice", "invoice"],
    ["pos_next.api.invoices.apply_offers", "invoice_data"],
  ];

  function invoicePatchField(url) {
    const match = INVOICE_PATCH_FIELDS.find(([endpoint]) => url.includes(endpoint));
    return match ? match[1] : null;
  }

  function getHeaderValue(headers, name) {
    if (!headers) return "";
    if (typeof Headers !== "undefined" && headers instanceof Headers) {
      return headers.get(name) || "";
    }
    const target = name.toLowerCase();
    const key = Object.keys(headers).find((item) => item.toLowerCase() === target);
    return key ? String(headers[key] || "") : "";
  }

  function patchContainerField(container, field) {
    if (!container || !Object.prototype.hasOwnProperty.call(container, field)) {
      return false;
    }

    const raw = container[field];
    if (raw === undefined || raw === null || raw === "") {
      return false;
    }

    let payload = raw;
    let serialized = false;
    if (typeof raw === "string") {
      try {
        payload = JSON.parse(raw);
        serialized = true;
      } catch (_error) {
        return false;
      }
    }

    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return false;
    }

    writeInvoiceDateFields(payload);
    container[field] = serialized ? JSON.stringify(payload) : payload;
    return true;
  }

  function patchRequestPayload(url, init) {
    const field = invoicePatchField(url || "");
    if (!field || !init || !init.body) {
      return init;
    }

    const body = init.body;

    if (typeof URLSearchParams !== "undefined" && body instanceof URLSearchParams) {
      const params = new URLSearchParams(body.toString());
      const raw = params.get(field);
      if (!raw) return init;
      const holder = { [field]: raw };
      if (!patchContainerField(holder, field)) return init;
      params.set(field, holder[field]);
      return Object.assign({}, init, { body: params });
    }

    if (typeof FormData !== "undefined" && body instanceof FormData) {
      const form = new FormData();
      body.forEach((value, key) => form.append(key, value));
      const raw = form.get(field);
      if (typeof raw !== "string" || !raw) return init;
      const holder = { [field]: raw };
      if (!patchContainerField(holder, field)) return init;
      form.set(field, holder[field]);
      return Object.assign({}, init, { body: form });
    }

    if (typeof body !== "string") {
      return init;
    }

    const contentType = getHeaderValue(init.headers, "Content-Type").toLowerCase();
    const trimmed = body.trim();
    if (contentType.includes("application/json") || trimmed.startsWith("{")) {
      let jsonBody;
      try {
        jsonBody = JSON.parse(body);
      } catch (_error) {
        return init;
      }
      if (!jsonBody || typeof jsonBody !== "object" || Array.isArray(jsonBody)) {
        return init;
      }
      if (!patchContainerField(jsonBody, field)) {
        return init;
      }
      return Object.assign({}, init, { body: JSON.stringify(jsonBody) });
    }

    const params = new URLSearchParams(body);
    const raw = params.get(field);
    if (!raw) {
      return init;
    }
    const holder = { [field]: raw };
    if (!patchContainerField(holder, field)) {
      return init;
    }
    params.set(field, holder[field]);

    const nextInit = Object.assign({}, init, { body: params.toString() });
    nextInit.headers = Object.assign({}, init.headers || {});
    if (!getHeaderValue(nextInit.headers, "Content-Type")) {
      nextInit.headers["Content-Type"] = "application/x-www-form-urlencoded; charset=UTF-8";
    }
    return nextInit;
  }

  function patchFetch() {
    if (
      !window.fetch ||
      window.fetch.__processedgePosnextPatched ||
      !STATE.settings ||
      !STATE.settings.allow_editing_posting_date
    ) {
      return;
    }

    const originalFetch = window.fetch.bind(window);
    const patched = function (input, init) {
      const url = typeof input === "string" ? input : input && input.url;
      if (url && isPOSPage() && invoicePatchField(url)) {
        init = patchRequestPayload(url, init);
      }
      return originalFetch(input, init);
    };

    patched.__processedgePosnextPatched = true;
    patched.__processedgePosnextOriginal = originalFetch;
    window.fetch = patched;
  }

  function createPostingDateField(dialogBody) {
    if (!dialogBody || dialogBody.querySelector("[data-processedge-posting-date]")) {
      return;
    }

    const target = dialogBody.querySelector(".bg-orange-50, .lg\\:col-span-2, .grid");
    if (!target || !target.parentNode) {
      return;
    }

    const wrapper = document.createElement("div");
    wrapper.setAttribute("data-processedge-posting-date", "1");
    wrapper.className = "bg-blue-50 border border-blue-200 rounded-lg p-2";
    wrapper.innerHTML = [
      '<div class="flex items-center gap-2">',
      '<svg class="w-4 h-4 text-blue-600 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">',
      '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"></path>',
      "</svg>",
      '<label class="text-xs font-medium text-blue-700 flex-shrink-0">Posting Date</label>',
      `<input type="date" value="${STATE.postingDate || getToday()}" class="flex-1 h-8 border border-blue-300 rounded-lg px-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent bg-white" />`,
      "</div>",
      "</div>",
    ].join("");

    const input = wrapper.querySelector("input");
    if (input) {
      input.addEventListener("change", function (event) {
        STATE.postingDate = event.target.value || getToday();
      });
    }

    target.parentNode.insertBefore(wrapper, target);
  }

  function createPersistentPostingDateField(container) {
    if (!container || container.querySelector("[data-processedge-posting-date-global]")) {
      return;
    }

    const wrapper = document.createElement("div");
    wrapper.setAttribute("data-processedge-posting-date-global", "1");
    wrapper.className = "processedge-posting-date-global";
    wrapper.style.cssText = [
      "display:flex",
      "align-items:center",
      "gap:8px",
      "padding:8px 12px",
      "margin:8px 0",
      "border:1px solid #bfdbfe",
      "border-radius:12px",
      "background:#eff6ff",
      "font-size:14px",
      "width:fit-content",
      "max-width:100%",
    ].join(";");
    wrapper.innerHTML = [
      '<label style="font-weight:600;color:#1d4ed8;white-space:nowrap;">Posting Date</label>',
      `<input type="date" value="${STATE.postingDate || getToday()}" style="height:36px;padding:0 10px;border:1px solid #93c5fd;border-radius:10px;background:#fff;min-width:170px;" />`,
    ].join("");

    const input = wrapper.querySelector("input");
    if (input) {
      input.addEventListener("change", function (event) {
        STATE.postingDate = event.target.value || getToday();
      });
    }

    container.prepend(wrapper);
  }

  function createFloatingPostingDateField() {
    if (document.querySelector("[data-processedge-posting-date-floating]")) {
      return;
    }

    const wrapper = document.createElement("div");
    wrapper.setAttribute("data-processedge-posting-date-floating", "1");
    wrapper.style.cssText = [
      "position:fixed",
      "right:24px",
      "bottom:96px",
      "z-index:9999",
      "display:flex",
      "align-items:center",
      "gap:8px",
      "padding:10px 12px",
      "border:1px solid #bfdbfe",
      "border-radius:14px",
      "background:#eff6ff",
      "box-shadow:0 10px 30px rgba(15, 23, 42, 0.12)",
      "font-size:14px",
      "max-width:calc(100vw - 48px)",
    ].join(";");
    wrapper.innerHTML = [
      '<label style="font-weight:600;color:#1d4ed8;white-space:nowrap;">Posting Date</label>',
      `<input type="date" value="${STATE.postingDate || getToday()}" style="height:36px;padding:0 10px;border:1px solid #93c5fd;border-radius:10px;background:#fff;min-width:170px;" />`,
    ].join("");

    const input = wrapper.querySelector("input");
    if (input) {
      input.addEventListener("change", function (event) {
        STATE.postingDate = event.target.value || getToday();
      });
    }

    document.body.appendChild(wrapper);
  }

  function injectPostingDateIntoPage() {
    if (!STATE.settings || !STATE.settings.allow_editing_posting_date) {
      return;
    }

    const candidates = [
      "[data-v-app] main",
      "#app main",
      ".layout-main-section",
      ".page-content",
      "main",
    ];

    for (const selector of candidates) {
      const container = document.querySelector(selector);
      if (container) {
        createPersistentPostingDateField(container);
        createFloatingPostingDateField();
        return;
      }
    }

    createFloatingPostingDateField();
  }

  function unlockRateInputs() {
    if (!STATE.settings || !STATE.settings.allow_editable_selling_price) {
      return;
    }

    const dialogs = Array.from(document.querySelectorAll("[role='dialog'], .dialog-content, .frappe-dialog, .z-dialog-content"));
    dialogs.forEach((dialog) => {
      const text = dialog.textContent || "";
      if (!text.includes("Edit Item Details")) {
        return;
      }

      const rateLabels = Array.from(dialog.querySelectorAll("label")).filter((label) =>
        (label.textContent || "").trim() === "Rate"
      );

      rateLabels.forEach((label) => {
        const section = label.parentElement;
        if (!section) {
          return;
        }

        const input = section.querySelector("input[type='number']");
        if (!input) {
          return;
        }

        input.readOnly = false;
        input.removeAttribute("readonly");
        input.disabled = false;
        input.removeAttribute("disabled");
        input.classList.remove("cursor-not-allowed", "bg-gray-50");
        input.classList.add("bg-white");
        input.title = "Editable by ProcessEdge POSNext Override";

        const warning = section.querySelector("p");
        if (warning && /locked|disabled/i.test(warning.textContent || "")) {
          warning.style.display = "none";
        }
      });
    });
  }

  function patchUI() {
    unlockRateInputs();
    injectCashierExpenseAction();

    if (!STATE.settings || !STATE.settings.allow_editing_posting_date) {
      return;
    }

    injectPostingDateIntoPage();

    const dialogTitles = Array.from(document.querySelectorAll("[role='dialog'], .dialog-content, .frappe-dialog, .z-dialog-content"));
    dialogTitles.forEach((dialog) => {
      if (!dialog || dialog.querySelector("[data-processedge-posting-date]")) {
        return;
      }

      const text = dialog.textContent || "";
      if (
        text.includes("Complete Payment") ||
        text.includes("Complete Sales Order") ||
        text.includes("Payment") ||
        text.includes("Amount Paid")
      ) {
        createPostingDateField(dialog);
      }
    });
  }

  function startObserver() {
    if (STATE.observer) {
      STATE.observer.disconnect();
    }

    STATE.observer = new MutationObserver(function () {
      patchUI();
    });

    STATE.observer.observe(document.body, {
      childList: true,
      subtree: true,
    });
  }

  async function boot() {
    if (!isPOSPage()) {
      return;
    }

    await loadSettings();
    await loadCashierExpenseBridge();
    patchFetch();
    patchUI();
    startObserver();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
