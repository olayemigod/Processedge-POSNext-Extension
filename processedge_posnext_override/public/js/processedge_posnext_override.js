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
    printing: {
      lastSubmittedInvoice: null,
      autoPrintedInvoices: new Set(),
      busy: false,
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
    "pos_next.api.customers.create_customer",
  ]);
  const SUBMIT_INVOICE_ENDPOINT = "pos_next.api.invoices.submit_invoice";
  const EDGE_RECEIPT_METHOD =
    "processedge_posnext_override.api.get_edgesuite_receipt_print_payload";

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
        require_customer_phone: 1,
        native_customer_phone_policy: 0,
        edgesuite_receipt_printing_enabled: 0,
        edgesuite_auto_print_requested: 0,
        edgesuite_auto_print_effective: 0,
        edgesuite_printing_available: 0,
        edgesuite_printing_reason: "",
        posnext_native_auto_print: 0,
        posnext_silent_print: 0,
        company: "",
        branch: "",
      };
      STATE.postingDate = getToday();
    }
  }


  function sharedPrintAdapter() {
    return (
      window.EdgeSuitePrint ||
      window.EdgeSuiteUI?.print ||
      window.EdgeSuiteUI?.getAdapter?.("print") ||
      null
    );
  }

  function edgeSuitePrintingEnabled() {
    return Boolean(
      STATE.settings &&
        Number(STATE.settings.edgesuite_receipt_printing_enabled || 0) &&
        Number(STATE.settings.edgesuite_printing_available || 0)
    );
  }

  function edgeSuiteAutoPrintEnabled() {
    return Boolean(
      edgeSuitePrintingEnabled() &&
        Number(STATE.settings.edgesuite_auto_print_effective || 0)
    );
  }

  function edgeSuitePrinterSetupUrl(context = {}) {
    const params = new URLSearchParams({
      purpose: "Receipt",
      product_key: "retailedge",
    });
    const company = String(context.company || STATE.settings?.company || "").trim();
    const branch = String(context.branch || STATE.settings?.branch || "").trim();
    if (company) params.set("company", company);
    if (branch) params.set("branch", branch);
    return `/app/edge-printing?${params.toString()}`;
  }

  function openEdgeSuitePrinterSetup(context = {}) {
    const url = edgeSuitePrinterSetupUrl(context);
    const opened = window.open(url, "_blank", "noopener,noreferrer");
    if (!opened) {
      showPOSAlert("Open Devices & Printing from RetailEdge Business Setup.", "orange");
      return false;
    }
    return true;
  }

  function printError(code, message, cause) {
    const error = new Error(message);
    error.code = code;
    if (cause) error.cause = cause;
    return error;
  }

  async function ensureEdgeSuitePrinter(adapter, profile) {
    if (!adapter?.devices || !adapter?.profiles || typeof adapter.printReceipt !== "function") {
      throw printError(
        "PROCESS_EDGE_PRINT_RUNTIME_UNAVAILABLE",
        "The EdgeSuite receipt printer runtime is not available on this POS page."
      );
    }
    if (!profile || profile.transport !== "serial") {
      throw printError(
        "PROCESS_EDGE_SERIAL_PROFILE_REQUIRED",
        "Direct POS receipt printing requires an EdgeSuite Serial receipt profile."
      );
    }

    const status = adapter.getStatus?.("serial");
    if (status?.connected) return status;

    try {
      const restored = await adapter.devices.connectBoundSerial(
        profile.name,
        adapter.profiles.connectionOptions(profile)
      );
      if (!restored?.status?.connected) {
        throw new Error("Printer did not reconnect.");
      }
      return restored.status;
    } catch (error) {
      throw printError(
        "PROCESS_EDGE_PRINTER_SETUP_REQUIRED",
        "Connect this POS device to its receipt printer in Devices & Printing.",
        error
      );
    }
  }

  function buildEdgeSuiteReceiptDocument(receipt, options, profile) {
    const sourceBlocks = Array.isArray(receipt?.blocks) ? receipt.blocks : [];
    const blocks = sourceBlocks
      .filter((block) => options.printQr || block?.type !== "qr")
      .map((block) => ({ ...block }));

    if (Number(options.feedLines || 0) > 0) {
      blocks.push({ type: "feed", lines: Number(options.feedLines) });
    }
    if (options.autoCut) {
      blocks.push({ type: "cut", mode: options.cutMode || "partial" });
    }

    return {
      paper: options.paper,
      charactersPerLine: options.charactersPerLine,
      blocks,
      metadata: {
        ...(receipt?.metadata || {}),
        product: "retailedge",
        source: "posnext_extension",
        profile: profile.name,
      },
    };
  }

  async function printEdgeSuiteInvoice(invoiceName, { automatic = false } = {}) {
    const name = String(invoiceName || "").trim();
    if (!name) throw new TypeError("Submitted Sales Invoice name is required.");
    if (!edgeSuitePrintingEnabled()) {
      throw printError(
        "PROCESS_EDGE_PRINTING_DISABLED",
        STATE.settings?.edgesuite_printing_reason ||
          "EdgeSuite receipt printing is not enabled for this POS."
      );
    }
    if (automatic && STATE.printing.autoPrintedInvoices.has(name)) {
      return { printed: false, duplicate: true, name };
    }

    const adapter = sharedPrintAdapter();
    if (!adapter) {
      throw printError(
        "PROCESS_EDGE_PRINT_RUNTIME_UNAVAILABLE",
        "The EdgeSuite receipt printer runtime did not load on this POS page."
      );
    }

    STATE.printing.busy = true;
    try {
      const payload = await callAPI(EDGE_RECEIPT_METHOD, { invoice_name: name });
      if (!payload?.available) {
        throw printError(
          "PROCESS_EDGE_PRINTING_UNAVAILABLE",
          payload?.reason || "Shared receipt printing is unavailable on this site."
        );
      }
      if (!payload?.profile) {
        throw printError(
          "PROCESS_EDGE_PRINTER_PROFILE_REQUIRED",
          payload?.reason || "No receipt printer profile matches this sale."
        );
      }
      if (!payload?.receipt) {
        throw printError(
          "PROCESS_EDGE_RECEIPT_UNAVAILABLE",
          "RetailEdge did not return a printable submitted receipt."
        );
      }

      const profile = adapter.profiles.normalize(payload.profile);
      await ensureEdgeSuitePrinter(adapter, profile);
      const options = adapter.profiles.receiptOptions(profile);
      const documentPayload = buildEdgeSuiteReceiptDocument(
        payload.receipt,
        options,
        profile
      );
      const copies = Math.max(1, Number(options.copies || 1));
      const results = [];
      for (let copy = 0; copy < copies; copy += 1) {
        results.push(await adapter.printReceipt(documentPayload));
      }

      if (automatic) STATE.printing.autoPrintedInvoices.add(name);
      showPOSAlert(
        `Receipt ${name} printed${copies > 1 ? ` (${copies} copies)` : ""}.`,
        "green"
      );
      return { printed: true, name, copies, results, profile };
    } finally {
      STATE.printing.busy = false;
    }
  }

  function submittedInvoiceFromResponse(payload) {
    const message =
      payload && Object.prototype.hasOwnProperty.call(payload, "message")
        ? payload.message
        : payload;
    const result = message?.message || message || {};
    const name = String(result?.name || "").trim();
    if (!name) return null;
    return {
      name,
      doctype: String(result?.doctype || "Sales Invoice"),
      company: String(result?.company || ""),
      branch: String(result?.branch || ""),
    };
  }

  async function observeSubmittedInvoiceResponse(url, response) {
    if (
      !edgeSuitePrintingEnabled() ||
      !url?.includes(SUBMIT_INVOICE_ENDPOINT) ||
      !response?.ok ||
      typeof response.clone !== "function"
    ) {
      return;
    }

    let payload = null;
    try {
      payload = await response.clone().json();
    } catch (_error) {
      return;
    }
    const invoice = submittedInvoiceFromResponse(payload);
    if (!invoice || invoice.doctype !== "Sales Invoice") return;

    STATE.printing.lastSubmittedInvoice = invoice;
    if (edgeSuiteAutoPrintEnabled()) {
      window.setTimeout(() => {
        printEdgeSuiteInvoice(invoice.name, { automatic: true }).catch((error) => {
          console.warn("ProcessEdge POS: EdgeSuite auto-print failed", error);
          showPOSAlert(
            "Sale completed, but the EdgeSuite receipt did not print. Use Print Receipt to retry.",
            "orange"
          );
        });
      }, 0);
    }
  }

  function successDialogInvoiceName(dialog) {
    const remembered = String(STATE.printing.lastSubmittedInvoice?.name || "").trim();
    if (remembered) return remembered;
    const text = String(dialog?.textContent || "");
    const match = text.match(/Invoice\s+([^\s]+)\s+created successfully/i);
    return match?.[1] || "";
  }

  function injectEdgeSuiteReceiptAction() {
    if (!edgeSuitePrintingEnabled()) return;

    const dialogs = Array.from(
      document.querySelectorAll("[role='dialog'], .dialog-content, .frappe-dialog, .z-dialog-content")
    ).filter((dialog) => /Invoice\s+.+\s+created successfully/i.test(dialog.textContent || ""));

    dialogs.forEach((dialog) => {
      if (dialog.querySelector("[data-processedge-edgesuite-print-receipt]")) return;
      const nativePrint = Array.from(dialog.querySelectorAll("button")).find((button) =>
        /Print Invoice/i.test(String(button.textContent || ""))
      );
      const actions = nativePrint?.parentElement;
      if (!actions) return;

      const button = document.createElement("button");
      button.type = "button";
      button.setAttribute("data-processedge-edgesuite-print-receipt", "1");
      button.textContent = "Print Receipt";
      button.className = nativePrint.className || "";
      button.style.cssText =
        "min-height:36px;border-radius:8px;padding:8px 14px;font-weight:700;cursor:pointer;";
      button.addEventListener("click", async () => {
        const name = successDialogInvoiceName(dialog);
        if (!name || STATE.printing.busy) return;
        button.disabled = true;
        const previous = button.textContent;
        button.textContent = "Printing...";
        try {
          await printEdgeSuiteInvoice(name);
        } catch (error) {
          console.warn("ProcessEdge POS: EdgeSuite receipt print failed", error);
          const setupRequired = [
            "PROCESS_EDGE_PRINT_RUNTIME_UNAVAILABLE",
            "PROCESS_EDGE_SERIAL_PROFILE_REQUIRED",
            "PROCESS_EDGE_PRINTER_SETUP_REQUIRED",
            "PROCESS_EDGE_PRINTER_PROFILE_REQUIRED",
          ].includes(error?.code);
          showPOSAlert(error?.message || "Unable to print receipt.", "orange");
          if (setupRequired && window.confirm("Open Devices & Printing now?")) {
            openEdgeSuitePrinterSetup();
          }
        } finally {
          button.disabled = false;
          button.textContent = previous;
        }
      });

      actions.insertBefore(button, nativePrint);
    });
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
      '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 3h10a2 2 0 012 2v16l-3-2-4 2-4-2-3 2V5a2 2 0 012-2z"></path>',
      '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 8h6M9 12h6M9 16h3"></path>',
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

  function clampFloatingButton(button) {
    if (!button) return;
    const rect = button.getBoundingClientRect();
    const margin = 8;
    const maxLeft = Math.max(margin, window.innerWidth - rect.width - margin);
    const maxTop = Math.max(margin, window.innerHeight - rect.height - margin);
    const left = Math.min(Math.max(rect.left, margin), maxLeft);
    const top = Math.min(Math.max(rect.top, margin), maxTop);
    button.style.left = left + "px";
    button.style.top = top + "px";
    button.style.right = "auto";
    button.style.bottom = "auto";
  }

  function restoreCashierExpenseFloatingPosition(button) {
    try {
      const raw = window.localStorage.getItem("processedge.cashierExpenseFloatingPosition.v2");
      if (!raw) return;
      const saved = JSON.parse(raw);
      if (!Number.isFinite(saved.left) || !Number.isFinite(saved.top)) return;
      button.style.left = saved.left + "px";
      button.style.top = saved.top + "px";
      button.style.right = "auto";
      button.style.bottom = "auto";
      requestAnimationFrame(() => clampFloatingButton(button));
    } catch (_error) {
      // Position persistence is optional.
    }
  }

  function persistCashierExpenseFloatingPosition(button) {
    try {
      const rect = button.getBoundingClientRect();
      window.localStorage.setItem(
        "processedge.cashierExpenseFloatingPosition.v2",
        JSON.stringify({ left: rect.left, top: rect.top })
      );
    } catch (_error) {
      // Position persistence is optional.
    }
  }

  function makeCashierExpenseFloatingDraggable(button) {
    let pointerId = null;
    let startX = 0;
    let startY = 0;
    let startLeft = 0;
    let startTop = 0;
    let dragged = false;
    let suppressClick = false;

    button.addEventListener("pointerdown", (event) => {
      if (event.button !== undefined && event.button !== 0) return;
      const rect = button.getBoundingClientRect();
      pointerId = event.pointerId;
      startX = event.clientX;
      startY = event.clientY;
      startLeft = rect.left;
      startTop = rect.top;
      dragged = false;
      button.setPointerCapture?.(pointerId);
    });

    button.addEventListener("pointermove", (event) => {
      if (pointerId === null || event.pointerId !== pointerId) return;
      const dx = event.clientX - startX;
      const dy = event.clientY - startY;
      if (!dragged && Math.hypot(dx, dy) < 6) return;
      dragged = true;
      event.preventDefault();
      button.style.left = startLeft + dx + "px";
      button.style.top = startTop + dy + "px";
      button.style.right = "auto";
      button.style.bottom = "auto";
      clampFloatingButton(button);
    });

    const finish = (event) => {
      if (pointerId === null || (event.pointerId !== undefined && event.pointerId !== pointerId)) {
        return;
      }
      button.releasePointerCapture?.(pointerId);
      pointerId = null;
      if (dragged) {
        suppressClick = true;
        clampFloatingButton(button);
        persistCashierExpenseFloatingPosition(button);
        window.setTimeout(() => {
          suppressClick = false;
        }, 0);
      }
    };

    button.addEventListener("pointerup", finish);
    button.addEventListener("pointercancel", finish);
    button.addEventListener("click", (event) => {
      if (suppressClick || dragged) {
        event.preventDefault();
        event.stopPropagation();
        dragged = false;
        return;
      }
      openCashierExpenseDialog();
    });
  }

  function createCashierExpenseFloatingButton() {
    if (document.querySelector("[data-processedge-cashier-expense-action='floating']")) {
      return;
    }

    const button = document.createElement("button");
    button.type = "button";
    button.setAttribute("data-processedge-cashier-expense-action", "floating");
    button.setAttribute("aria-label", "Cashier Expense");
    button.title = "Cashier Expense — drag to reposition";
    const compact = window.innerWidth < 1024;
    button.style.cssText = [
      "position:fixed",
      "right:" + (compact ? "14px" : "20px"),
      "bottom:" + (compact ? "18px" : "24px"),
      "z-index:9000",
      "display:flex",
      "align-items:center",
      "justify-content:center",
      "gap:6px",
      "width:" + (compact ? "48px" : "auto"),
      "height:" + (compact ? "48px" : "48px"),
      "padding:" + (compact ? "0" : "0 14px"),
      "border:1px solid #a7f3d0",
      "border-radius:" + (compact ? "14px" : "14px"),
      "background:#ecfdf5",
      "color:#047857",
      "font-weight:700",
      "font-size:12px",
      "box-shadow:0 8px 24px rgba(15,23,42,.16)",
      "cursor:grab",
      "touch-action:none",
      "user-select:none",
    ].join(";");
    button.innerHTML = [
      '<svg width="' + (compact ? "21" : "20") + '" height="' + (compact ? "21" : "20") + '" fill="none" stroke="currentColor" viewBox="0 0 24 24">',
      '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 3h10a2 2 0 012 2v16l-3-2-4 2-4-2-3 2V5a2 2 0 012-2z"></path>',
      '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 8h6M9 12h6M9 16h3"></path>',
      "</svg>",
      compact ? "" : "<span>Cashier Expense</span>",
    ].join("");

    document.body.appendChild(button);
    restoreCashierExpenseFloatingPosition(button);
    makeCashierExpenseFloatingDraggable(button);
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
    await loadCashierExpenseBridge();
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

  function writeInvoiceDateFields(payload) {
    if (
      !payload ||
      typeof payload !== "object" ||
      Array.isArray(payload) ||
      !STATE.settings ||
      !STATE.settings.allow_editing_posting_date ||
      !STATE.postingDate
    ) {
      return payload;
    }

    payload.posting_date = STATE.postingDate;
    payload.transaction_date = STATE.postingDate;
    if (!payload.doctype || payload.doctype === "Sales Invoice") {
      payload.set_posting_time = 1;
    }
    return payload;
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

  function findPaymentDialogLeftColumn(dialogBody) {
    if (!dialogBody) return null;

    return (
      Array.from(dialogBody.querySelectorAll("div")).find((node) => {
        const classes = node.classList;
        return (
          classes &&
          classes.contains("lg:col-span-2") &&
          classes.contains("flex") &&
          classes.contains("flex-col")
        );
      }) || null
    );
  }

  function createPostingDateField(dialogBody) {
    if (!dialogBody || dialogBody.querySelector("[data-processedge-posting-date]")) {
      return;
    }

    // PaymentDialog owns a five-column root grid with exactly two structural
    // children: left column (2/5) and payment column (3/5). The posting-date
    // control must live INSIDE the left column. Adding another direct grid child
    // changes the native column allocation and can make Sales Person selection
    // and the partial-payment surface unusable.
    const leftColumn = findPaymentDialogLeftColumn(dialogBody);
    if (!leftColumn) {
      return;
    }

    const wrapper = document.createElement("div");
    wrapper.setAttribute("data-processedge-posting-date", "1");
    wrapper.setAttribute("data-processedge-posting-date-placement", "payment-left-column");
    wrapper.className =
      "bg-blue-50 border border-blue-200 rounded-lg p-2 flex-shrink-0";
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
        syncPostingDateInputs(event.target.value, event.target);
        schedulePaymentBridgeRefresh();
      });
    }

    leftColumn.insertBefore(wrapper, leftColumn.firstChild || null);
  }

  function syncPostingDateInputs(value, source) {
    STATE.postingDate = value || getToday();
    document
      .querySelectorAll("[data-processedge-posting-date-global] input[type='date'], [data-processedge-posting-date] input[type='date']")
      .forEach((input) => {
        if (input !== source && input.value !== STATE.postingDate) {
          input.value = STATE.postingDate;
        }
      });
  }

  function createPostingDateHeaderField(header) {
    if (!header || document.querySelector("[data-processedge-posting-date-global]")) {
      return;
    }

    const mainRow = Array.from(header.querySelectorAll("div")).find((node) => {
      const classes = node.classList;
      return classes && classes.contains("flex-1") && classes.contains("justify-between");
    });
    if (!mainRow || mainRow.children.length < 2) {
      return;
    }

    const rightControls = mainRow.children[1];
    const wrapper = document.createElement("div");
    wrapper.setAttribute("data-processedge-posting-date-global", "header");
    wrapper.title = "Posting Date";
    wrapper.style.cssText = [
      "display:flex",
      "align-items:center",
      "gap:5px",
      "height:34px",
      "padding:0 7px",
      "border:1px solid #bfdbfe",
      "border-radius:10px",
      "background:#eff6ff",
      "color:#1d4ed8",
      "flex-shrink:0",
      "box-sizing:border-box",
    ].join(";");

    const icon = document.createElement("span");
    icon.innerHTML = [
      '<svg width="15" height="15" fill="none" stroke="currentColor" viewBox="0 0 24 24">',
      '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"></path>',
      "</svg>",
    ].join("");
    icon.style.cssText = "display:flex;align-items:center;flex:0 0 auto;";

    const label = document.createElement("span");
    label.textContent = "Posting Date";
    label.style.cssText = "font-size:11px;font-weight:700;white-space:nowrap;";

    const input = document.createElement("input");
    input.type = "date";
    input.value = STATE.postingDate || getToday();
    input.setAttribute("aria-label", "Posting Date");
    input.style.cssText = [
      "height:26px",
      "width:132px",
      "border:0",
      "outline:0",
      "background:transparent",
      "color:#1e3a8a",
      "font-size:12px",
      "font-weight:600",
      "padding:0",
    ].join(";");
    input.addEventListener("change", (event) => {
      syncPostingDateInputs(event.target.value, event.target);
    });

    wrapper.appendChild(icon);
    wrapper.appendChild(label);
    wrapper.appendChild(input);

    const applyResponsive = () => {
      const mobile = window.innerWidth < 768;
      label.style.display = mobile ? "none" : "inline";
      input.style.width = mobile ? "112px" : "132px";
      wrapper.style.padding = mobile ? "0 5px" : "0 7px";
    };
    applyResponsive();
    window.addEventListener("resize", applyResponsive, { passive: true });

    rightControls.insertBefore(wrapper, rightControls.firstChild || null);
  }

  function createFloatingPostingDateField() {
    if (document.querySelector("[data-processedge-posting-date-global]")) {
      return;
    }

    const wrapper = document.createElement("div");
    wrapper.setAttribute("data-processedge-posting-date-global", "floating");
    wrapper.style.cssText = [
      "position:fixed",
      "right:12px",
      "top:76px",
      "z-index:8500",
      "display:flex",
      "align-items:center",
      "gap:5px",
      "height:34px",
      "padding:0 7px",
      "border:1px solid #bfdbfe",
      "border-radius:10px",
      "background:#eff6ff",
      "box-shadow:0 8px 24px rgba(15,23,42,.12)",
      "color:#1d4ed8",
    ].join(";");

    wrapper.innerHTML = [
      '<svg width="15" height="15" fill="none" stroke="currentColor" viewBox="0 0 24 24">',
      '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"></path>',
      "</svg>",
      '<input type="date" aria-label="Posting Date" value="' +
        (STATE.postingDate || getToday()) +
        '" style="height:26px;width:116px;border:0;outline:0;background:transparent;color:#1e3a8a;font-size:12px;font-weight:600;padding:0;" />',
    ].join("");

    const input = wrapper.querySelector("input");
    input.addEventListener("change", (event) => {
      syncPostingDateInputs(event.target.value, event.target);
    });

    document.body.appendChild(wrapper);
  }

  function injectPostingDateIntoPage() {
    if (!STATE.settings || !STATE.settings.allow_editing_posting_date) {
      document.querySelectorAll("[data-processedge-posting-date-global]").forEach((node) => node.remove());
      return;
    }

    const posButton = document.querySelector("button[title='POS Next'], button[aria-label='POS Next']");
    const header =
      (posButton && posButton.closest(".sticky")) ||
      Array.from(document.querySelectorAll("div.sticky")).find((node) => node.classList.contains("top-0"));

    if (header) {
      createPostingDateHeaderField(header);
      const floating = document.querySelector("[data-processedge-posting-date-global='floating']");
      if (floating) floating.remove();
      return;
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

  function normalizedLabelText(value) {
    return String(value || "").replace(/\*/g, "").trim();
  }

  function findDialogField(dialog, labelText) {
    if (!dialog) return null;
    const label = Array.from(dialog.querySelectorAll("label")).find(
      (item) => normalizedLabelText(item.textContent) === labelText
    );
    if (!label) return null;

    const forId = label.getAttribute("for");
    if (forId) {
      const escaped = window.CSS && typeof window.CSS.escape === "function" ? window.CSS.escape(forId) : forId;
      const byId = dialog.querySelector("#" + escaped);
      if (byId) return byId;
    }

    const container = label.parentElement;
    return container ? container.querySelector("input:not([type='hidden']), select, textarea") : null;
  }

  function fieldValue(dialog, labelText) {
    const control = findDialogField(dialog, labelText);
    return control && typeof control.value === "string" ? control.value.trim() : "";
  }

  function findVueComponentInstance(element, componentName) {
    let node = element;
    while (node) {
      let instance = node.__vueParentComponent || null;
      while (instance) {
        const type = instance.type || {};
        const name = type.__name || type.name || "";
        if (name === componentName) {
          return instance;
        }
        instance = instance.parent || null;
      }
      node = node.parentElement;
    }
    return null;
  }

  function isBlankCustomerPhone(dialog) {
    const phone = findDialogField(dialog, "Mobile Number");
    return !phone || !String(phone.value || "").trim();
  }

  async function createCustomerWithoutPhone(dialog, button) {
    if (!dialog || !button || button.dataset.processedgeSubmitting === "1") {
      return;
    }

    const firstName = fieldValue(dialog, "First Name");
    const lastName = fieldValue(dialog, "Last Name");
    const customerName =
      fieldValue(dialog, "Customer Name") || [firstName, lastName].filter(Boolean).join(" ");

    if (!customerName) {
      showPOSAlert("Customer Name is required.", "orange");
      return;
    }

    button.dataset.processedgeSubmitting = "1";
    button.disabled = true;
    const previousText = button.textContent;
    button.textContent = "Creating...";

    try {
      const customer = await callAPI("pos_next.api.customers.create_customer", {
        customer_name: customerName,
        mobile_no: "",
        email_id: fieldValue(dialog, "Email"),
        customer_group: fieldValue(dialog, "Customer Group"),
        territory: fieldValue(dialog, "Territory"),
        custom_governorate: fieldValue(dialog, "Governorate"),
        custom_district: fieldValue(dialog, "District"),
        custom_first_name: firstName,
        custom_last_name: lastName,
        custom_is_publish: 1,
        pos_profile: STATE.settings && STATE.settings.pos_profile ? STATE.settings.pos_profile : "",
      });

      const component = findVueComponentInstance(dialog, "CreateCustomerDialog");
      if (component && typeof component.emit === "function") {
        component.emit("customer-created", customer);
        component.emit("update:modelValue", false);
      } else {
        const cancelButton = Array.from(dialog.querySelectorAll("button")).find(
          (item) => (item.textContent || "").trim() === "Cancel"
        );
        if (cancelButton) cancelButton.click();
      }

      showPOSAlert("Customer created without phone number.", "green");
    } catch (error) {
      const message =
        error && error.message ? error.message : "Unable to create customer without phone number.";
      showPOSAlert(message, "orange");
    } finally {
      button.dataset.processedgeSubmitting = "0";
      button.disabled = false;
      button.textContent = previousText || "Create Customer";
    }
  }

  function customerIdentityIsReady(dialog) {
    const firstNameField = findDialogField(dialog, "First Name");
    const lastNameField = findDialogField(dialog, "Last Name");

    if (firstNameField || lastNameField) {
      return Boolean(
        firstNameField &&
          lastNameField &&
          String(firstNameField.value || "").trim() &&
          String(lastNameField.value || "").trim()
      );
    }

    return Boolean(fieldValue(dialog, "Customer Name"));
  }

  function markPhoneOptional(dialog) {
    const phoneLabel = Array.from(dialog.querySelectorAll("label")).find(
      (item) => normalizedLabelText(item.textContent) === "Mobile Number"
    );
    if (!phoneLabel) return;

    const requiredMarker = Array.from(phoneLabel.querySelectorAll("span")).find(
      (item) => String(item.textContent || "").trim() === "*"
    );
    if (requiredMarker) {
      requiredMarker.style.display = "none";
      requiredMarker.setAttribute("data-processedge-phone-required-marker", "hidden");
    }

    if (!phoneLabel.querySelector("[data-processedge-phone-optional-label]")) {
      const optional = document.createElement("span");
      optional.setAttribute("data-processedge-phone-optional-label", "1");
      optional.className = "text-xs text-gray-400 ms-1";
      optional.textContent = "(optional)";
      phoneLabel.appendChild(optional);
    }
  }

  function findNativeCreateCustomerButton(dialog) {
    if (!dialog) return null;
    return Array.from(dialog.querySelectorAll("button")).find(
      (item) =>
        !item.hasAttribute("data-processedge-create-customer-without-phone") &&
        (item.textContent || "").trim() === "Create Customer"
    ) || null;
  }

  function removeOptionalPhoneFallback(dialog, nativeCreateButton) {
    if (!dialog) return;

    dialog
      .querySelectorAll("[data-processedge-create-customer-without-phone]")
      .forEach((node) => node.remove());

    const nativeButton = nativeCreateButton || findNativeCreateCustomerButton(dialog);
    if (nativeButton && nativeButton.dataset.processedgeHiddenForPhoneFallback === "1") {
      nativeButton.style.display = "";
      nativeButton.removeAttribute("data-processedge-hidden-for-phone-fallback");
    }
  }

  function ensureOptionalPhoneFallback(dialog) {
    if (!dialog) return;

    const nativeCreateButton = findNativeCreateCustomerButton(dialog);
    if (!nativeCreateButton) return;

    const permissionBlocked = (dialog.textContent || "").includes("Permission Required");
    const canCreateWithoutPhone =
      !permissionBlocked && customerIdentityIsReady(dialog) && isBlankCustomerPhone(dialog);

    // Current POSNext builds handle optional phone natively. Stand down whenever
    // Vue has already enabled its own Create Customer action.
    if (!canCreateWithoutPhone || !nativeCreateButton.disabled) {
      removeOptionalPhoneFallback(dialog, nativeCreateButton);
      return;
    }

    // Older POSNext 2.0 frontends can keep the native button disabled even when
    // the server/profile policy allows a blank phone. Do not fight Vue over the
    // disabled attribute: render one extension-owned action that delegates to
    // the same POSNext customer API.
    let fallback = dialog.querySelector(
      "[data-processedge-create-customer-without-phone]"
    );

    if (!fallback) {
      fallback = document.createElement("button");
      fallback.type = "button";
      fallback.setAttribute("data-processedge-create-customer-without-phone", "1");
      fallback.textContent = "Create Customer";
      fallback.className =
        "inline-flex items-center justify-center rounded-md bg-blue-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-blue-700 active:bg-blue-800 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50 disabled:cursor-not-allowed";
      fallback.style.cssText =
        "min-height:36px;border:0;border-radius:8px;padding:8px 16px;background:#2563eb;color:#fff;font-weight:700;cursor:pointer;";

      fallback.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        createCustomerWithoutPhone(dialog, fallback);
      });

      nativeCreateButton.parentElement.insertBefore(fallback, nativeCreateButton);
    }

    if (nativeCreateButton.dataset.processedgeHiddenForPhoneFallback !== "1") {
      nativeCreateButton.style.display = "none";
      nativeCreateButton.setAttribute(
        "data-processedge-hidden-for-phone-fallback",
        "1"
      );
    }
  }

  function bindLegacyOptionalPhoneInputs(dialog) {
    ["Customer Name", "First Name", "Last Name", "Mobile Number"].forEach((labelText) => {
      const input = findDialogField(dialog, labelText);
      if (!input || input.dataset.processedgeOptionalPhoneInputBound) return;

      input.dataset.processedgeOptionalPhoneInputBound = "1";
      const refresh = () => {
        window.requestAnimationFrame(() => ensureOptionalPhoneFallback(dialog));
      };
      input.addEventListener("input", refresh);
      input.addEventListener("change", refresh);
    });
  }

  function injectOptionalCustomerPhoneAction() {
    const requirePhone =
      !STATE.settings || STATE.settings.require_customer_phone === undefined
        ? true
        : Boolean(Number(STATE.settings.require_customer_phone));

    const dialogs = Array.from(
      document.querySelectorAll("[role='dialog'], .dialog-content, .frappe-dialog, .z-dialog-content")
    ).filter((dialog) => (dialog.textContent || "").includes("Create New Customer"));

    if (requirePhone) {
      dialogs.forEach((dialog) => removeOptionalPhoneFallback(dialog));
      return;
    }

    dialogs.forEach((dialog) => {
      markPhoneOptional(dialog);
      bindLegacyOptionalPhoneInputs(dialog);
      ensureOptionalPhoneFallback(dialog);
    });
  }

  const MOBILE_PARTIAL_PAYMENT_ATTR = "data-processedge-mobile-partial-payment";

  function normalizedButtonText(button) {
    return String((button && button.textContent) || "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function isNativeCompletionButton(button) {
    const text = normalizedButtonText(button);
    return (
      text === "Complete Payment" ||
      text === "Partial Payment" ||
      text === "Processing..."
    );
  }

  function findDesktopCompletionButton(dialog) {
    if (!dialog) return null;

    const desktopRows = Array.from(
      dialog.querySelectorAll("div.hidden.lg\\:flex.items-center.gap-2")
    );

    for (const row of desktopRows) {
      const buttons = Array.from(row.querySelectorAll("button"));
      if (!buttons.length) continue;

      // POSNext renders the completion action last in the desktop action row.
      // Prefer the semantic label when available, but fall back to the final
      // button so translations do not break the compatibility bridge.
      const semantic = buttons.find(isNativeCompletionButton);
      if (semantic) return semantic;

      return buttons[buttons.length - 1] || null;
    }

    return null;
  }

  function findMobilePaymentSection(dialog) {
    if (!dialog) return null;

    const explicit = dialog.querySelector("div.lg\\:hidden.flex.flex-col");
    if (explicit) return explicit;

    // Fallback for minor upstream class changes: find the mobile-only section
    // containing the remaining-balance Pay action.
    return Array.from(dialog.querySelectorAll("div")).find((node) => {
      if (!node.classList || !node.classList.contains("lg:hidden")) return false;
      return Array.from(node.querySelectorAll("button")).some((button) =>
        /^Pay\s+/i.test(normalizedButtonText(button))
      );
    }) || null;
  }

  function removeMobilePartialPaymentBridge(scope) {
    if (!scope) return;
    scope
      .querySelectorAll(`[${MOBILE_PARTIAL_PAYMENT_ATTR}]`)
      .forEach((node) => node.remove());
  }

  function findPaymentColumnForMobileSection(mobileSection) {
    if (!mobileSection) return null;

    let node = mobileSection.parentElement;
    while (node && node !== document.body) {
      if (
        node.classList &&
        node.classList.contains("lg:col-span-3") &&
        node.classList.contains("flex") &&
        node.classList.contains("flex-col")
      ) {
        return node;
      }
      node = node.parentElement;
    }

    return mobileSection.parentElement || null;
  }

  function injectMobilePartialPaymentAction() {
    const mobileSections = Array.from(
      document.querySelectorAll("div.lg\\:hidden.flex.flex-col")
    );

    mobileSections.forEach((mobileSection) => {
      const paymentColumn = findPaymentColumnForMobileSection(mobileSection);
      if (!paymentColumn) return;

      const existingBridge = mobileSection.querySelector(
        `[${MOBILE_PARTIAL_PAYMENT_ATTR}]`
      );

      // If BrainWise has shipped the native mobile completion/partial action,
      // the extension must immediately stand down to avoid duplicate controls.
      const nativeMobileCompletionButton = Array.from(
        mobileSection.querySelectorAll("button")
      ).find(
        (button) =>
          !button.hasAttribute(MOBILE_PARTIAL_PAYMENT_ATTR) &&
          isNativeCompletionButton(button)
      );

      if (nativeMobileCompletionButton) {
        removeMobilePartialPaymentBridge(mobileSection);
        return;
      }

      const desktopCompletionButton = findDesktopCompletionButton(paymentColumn);

      // POSNext already computes canComplete correctly for partial payments.
      // When the hidden desktop completion action is enabled while the mobile
      // completion action is absent, expose that same action on mobile.
      if (!desktopCompletionButton || desktopCompletionButton.disabled) {
        if (existingBridge) existingBridge.remove();
        return;
      }

      const hasOutstandingPayAction = Array.from(
        mobileSection.querySelectorAll("button")
      ).some(
        (button) =>
          !button.hasAttribute(MOBILE_PARTIAL_PAYMENT_ATTR) &&
          /^Pay\s+/i.test(normalizedButtonText(button))
      );

      if (!hasOutstandingPayAction) {
        if (existingBridge) existingBridge.remove();
        return;
      }

      let mobileButton = existingBridge;
      if (!mobileButton) {
        mobileButton = document.createElement("button");
        mobileButton.type = "button";
        mobileButton.setAttribute(MOBILE_PARTIAL_PAYMENT_ATTR, "1");
        mobileButton.textContent = "Partial Payment";
        mobileButton.className =
          "w-full inline-flex items-center justify-center gap-2 text-sm font-semibold px-5 rounded-lg bg-blue-600 text-white active:bg-blue-800 focus:outline-none";
        mobileButton.style.cssText =
          "width:100%;min-height:40px;border:0;border-radius:8px;padding:8px 16px;font-weight:700;cursor:pointer;";

        mobileButton.addEventListener("click", function () {
          const currentPaymentColumn =
            findPaymentColumnForMobileSection(mobileSection);
          const currentDesktopButton =
            findDesktopCompletionButton(currentPaymentColumn);
          if (!currentDesktopButton || currentDesktopButton.disabled) return;
          currentDesktopButton.click();
        });

        mobileSection.appendChild(mobileButton);
      }
    });
  }

  function patchUI() {
    injectOptionalCustomerPhoneAction();
    unlockRateInputs();
    injectCashierExpenseAction();
    injectMobilePartialPaymentAction();

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

  let paymentBridgeRefreshScheduled = false;

  function schedulePaymentBridgeRefresh() {
    if (paymentBridgeRefreshScheduled || !isPOSPage()) {
      return;
    }

    paymentBridgeRefreshScheduled = true;
    window.setTimeout(function () {
      window.requestAnimationFrame(function () {
        paymentBridgeRefreshScheduled = false;
        injectMobilePartialPaymentAction();
      });
    }, 0);
  }

  function isNativePOSExpenseButton(target) {
    const button = target && target.closest ? target.closest("button") : null;
    if (!button) return null;

    const title = String(button.getAttribute("title") || "").trim();
    const text = normalizedButtonText(button);
    if (
      title === "Record POS expense" ||
      text === "POS Expense" ||
      text.includes("POS Expense")
    ) {
      return button;
    }
    return null;
  }

  function bindNativePOSExpenseRouting() {
    if (document.documentElement.hasAttribute("data-processedge-pos-expense-routing")) {
      return;
    }

    document.documentElement.setAttribute("data-processedge-pos-expense-routing", "1");
    document.addEventListener(
      "click",
      (event) => {
        const button = isNativePOSExpenseButton(event.target);
        if (!button) return;

        const bridge = STATE.cashierExpense.bridge || {};
        if (!bridge.available || !bridge.enabled || !bridge.show_action) {
          return;
        }

        // Stop POSNext from opening its own ExpenseDialog. On legacy Neotex
        // profiles that endpoint can be disabled even while RetailEdge Cashier
        // Expense is the correct operational workflow.
        event.preventDefault();
        event.stopPropagation();
        if (typeof event.stopImmediatePropagation === "function") {
          event.stopImmediatePropagation();
        }
        openCashierExpenseDialog();
      },
      true
    );
  }

  function bindPaymentBridgeRefreshEvents() {
    if (document.documentElement.hasAttribute("data-processedge-partial-payment-events")) {
      return;
    }

    document.documentElement.setAttribute("data-processedge-partial-payment-events", "1");

    ["click", "input", "change"].forEach((eventName) => {
      document.addEventListener(eventName, schedulePaymentBridgeRefresh, true);
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
      characterData: true,
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
    bindNativePOSExpenseRouting();
    bindPaymentBridgeRefreshEvents();
    startObserver();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
