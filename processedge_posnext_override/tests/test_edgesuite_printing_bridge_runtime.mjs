import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const compatSource = await readFile(
  new URL("../public/js/processedge_pos_session_compat.js", import.meta.url),
  "utf8",
);
const source = await readFile(
  new URL("../public/js/processedge_posnext_override.js", import.meta.url),
  "utf8",
);

let printCount = 0;
let authMode = "success";
let configuredPaperWidth = 58;
const printedDocuments = [];
let connectedProfile = "Default Receipt";
let disconnectCount = 0;
let boundConnectCount = 0;
let forceRestoredBindingMismatch = false;
let failSerialOwnershipHandoff = false;
const adapter = {
  getStatus() {
    return { connected: Boolean(connectedProfile), state: connectedProfile ? "connected" : "disconnected" };
  },
  async disconnect(transport) {
    assert.equal(transport, "serial");
    disconnectCount += 1;
    connectedProfile = null;
    return this.getStatus();
  },
  devices: {
    bindingMatchesStatus(profileName, status) {
      return Boolean(
        status.connected
        && profileName === connectedProfile
        && !forceRestoredBindingMismatch
      );
    },
    async connectBoundSerial(profileName) {
      boundConnectCount += 1;
      if (failSerialOwnershipHandoff) {
        const error = new Error("The receipt printer is being used in another browser tab. Disconnect it there, then try again.");
        error.code = "SERIAL_TAB_IN_USE";
        throw error;
      }
      connectedProfile = profileName;
      return { status: adapter.getStatus() };
    },
  },
  profiles: {
    normalize(profile) {
      return {
        ...profile,
        name: profile.name || "Default Receipt",
        transport: "serial",
      };
    },
    connectionOptions() {
      return { openOptions: { baudRate: 19200 } };
    },
    receiptOptions() {
      return {
        paper: configuredPaperWidth,
        charactersPerLine: configuredPaperWidth === 58 ? 32 : 48,
        feedLines: 1,
        copies: 1,
        autoCut: false,
        cutMode: "partial",
        cashDrawer: false,
        drawerPin: 0,
        printQr: true,
      };
    },
    textEncoder() {
      return (value) => new TextEncoder().encode(String(value));
    },
  },
  async printReceipt(document, options) {
    printCount += 1;
    printedDocuments.push({ document, options });
    await new Promise((resolve) => setTimeout(resolve, 5));
    return { bytesWritten: 10, status: { connected: true } };
  },
};

function jsonResponse(message) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => "application/json" },
    async json() {
      return { message };
    },
    async text() {
      return JSON.stringify({ message });
    },
    clone() {
      return jsonResponse(message);
    },
  };
}

function errorResponse(status, payload) {
  return {
    ok: false,
    status,
    headers: { get: () => "application/json" },
    async json() {
      return payload;
    },
    async text() {
      return JSON.stringify(payload);
    },
    clone() {
      return errorResponse(status, payload);
    },
  };
}

const windowObject = {
  __PROCESS_EDGE_POSNEXT_TEST_MODE__: true,
  processedgePosnextOverrideInitialized: false,
  location: {
    pathname: "/pos",
    hostname: "processedge-test.invalid",
    origin: "https://processedge-test.invalid",
  },
  EdgeSuitePrint: adapter,
  setTimeout,
  requestAnimationFrame: (fn) => fn(),
  open: () => ({}),
  confirm: () => false,
};
windowObject.fetch = async (url) => {
  const text = String(url);
  if (text.includes("frappe.auth.get_logged_user")) {
    if (authMode === "network-error") {
      throw new TypeError("simulated startup network failure");
    }
    if (authMode === "permission-error") {
      return errorResponse(403, {
        exc_type: "PermissionError",
        exception: "frappe.exceptions.PermissionError",
      });
    }
    if (authMode === "authentication-error") {
      return errorResponse(401, {
        exc_type: "AuthenticationError",
        exception: "frappe.exceptions.AuthenticationError",
      });
    }
    return jsonResponse("browser-cashier@example.com");
  }
  if (text.includes("get_edgesuite_receipt_print_payload")) {
    return jsonResponse({
      available: 1,
      configured: 1,
      profile: {
        name: "Default Receipt",
        profile_name: "Default Receipt",
        transport: "Serial",
        text_encoding: "UTF-8",
      },
      receipt: {
        company: "RetailEdge Consulting",
        branch: "Ketu",
        // A 58mm printer must not receive the default 80mm preformatted rows.
        blocks: [{ type: "text", text: "80mm default receipt" }],
        blocks_by_paper: {
          "58": [{ type: "text", text: "58mm receipt" }],
          "80": [{ type: "text", text: "80mm receipt" }],
        },
      },
    });
  }
  throw new Error(`Unexpected fetch URL: ${url}`);
};

const documentObject = {
  cookie:
    "user_lang=en; system_user=yes; full_name=Browser%20Cashier; user_id=browser-cashier%40example.com",
};

const context = vm.createContext({
  window: windowObject,
  document: documentObject,
  console,
  URL,
  URLSearchParams,
  FormData: globalThis.FormData,
  TextEncoder,
  Response: globalThis.Response,
  setTimeout,
  clearTimeout,
});
vm.runInContext(compatSource, context, { filename: "processedge_pos_session_compat.js" });
vm.runInContext(source, context, { filename: "processedge_posnext_override.js" });

const test = windowObject.__ProcessEdgePOSNextPrintingTest;
assert.ok(test, "test seam should be exposed in explicit test mode");

// POSNext v1.17.0 treats any startup user-resource failure as logged out. The
// ProcessEdge compatibility bridge mirrors current upstream behavior while
// preserving genuine AuthenticationError responses.
authMode = "success";
let authResponse = await windowObject.fetch("/api/method/frappe.auth.get_logged_user");
assert.equal(authResponse.status, 200);
assert.equal((await authResponse.json()).message, "browser-cashier@example.com");

authMode = "network-error";
authResponse = await windowObject.fetch("/api/method/frappe.auth.get_logged_user");
assert.equal(authResponse.status, 200);
assert.equal((await authResponse.json()).message, "browser-cashier@example.com");

authMode = "permission-error";
authResponse = await windowObject.fetch("/api/method/frappe.auth.get_logged_user");
assert.equal(authResponse.status, 200);
assert.equal((await authResponse.json()).message, "browser-cashier@example.com");

authMode = "authentication-error";
authResponse = await windowObject.fetch("/api/method/frappe.auth.get_logged_user");
assert.equal(authResponse.status, 401, "real authentication failures must never be masked");

authMode = "success";
test.state.settings = {
  edgesuite_receipt_printing_enabled: 1,
  edgesuite_printing_available: 1,
  edgesuite_auto_print_effective: 1,
  company: "RetailEdge Consulting",
  branch: "Ketu",
};

const parsedInvoice = test.submittedInvoiceFromResponse({
  message: {
    name: "ACC-SINV-2026-00001",
    doctype: "Sales Invoice",
    company: "RetailEdge Consulting",
    branch: "Ketu",
  },
});
assert.equal(parsedInvoice.name, "ACC-SINV-2026-00001");
assert.equal(parsedInvoice.doctype, "Sales Invoice");
assert.equal(parsedInvoice.company, "RetailEdge Consulting");
assert.equal(parsedInvoice.branch, "Ketu");

assert.equal(
  test.requestContainsOfflineInvoice({
    body: new URLSearchParams({
      invoice: JSON.stringify({ offline_id: "pos_offline_123" }),
    }),
  }),
  true,
);
assert.equal(
  test.requestContainsOfflineInvoice({
    body: new URLSearchParams({
      invoice: JSON.stringify({ customer: "Walk In" }),
    }),
  }),
  false,
);
assert.equal(
  test.requestContainsOfflineInvoice({
    body: new URLSearchParams({
      invoice: JSON.stringify({ offline_id: "", customer: "Walk In" }),
    }),
  }),
  false,
);
assert.equal(test.isLocalOnlyReceiptName("pos_offline_123"), true);
assert.equal(test.isLocalOnlyReceiptName("ACC-SINV-2026-00002"), false);

const [first, duplicate] = await Promise.all([
  test.printEdgeSuiteInvoice("ACC-SINV-2026-00002", { automatic: true }),
  test.printEdgeSuiteInvoice("ACC-SINV-2026-00002", { automatic: true }),
]);
assert.equal(first.printed, true);
assert.equal(duplicate.duplicate, true);
assert.equal(printCount, 1, "in-flight automatic requests must print exactly once");
assert.equal(printedDocuments[0].document.paper, 58);
assert.equal(
  printedDocuments[0].document.blocks[0].text,
  "58mm receipt",
  "receipt layout must use the server's profile-specific 58mm block variant",
);
assert.equal(typeof printedDocuments[0].options.encodeText, "function");

const response = jsonResponse({
  name: "ACC-SINV-2026-00003",
  doctype: "Sales Invoice",
  company: "RetailEdge Consulting",
  branch: "Ketu",
});
await test.observeSubmittedInvoiceResponse(
  "/api/method/pos_next.api.invoices.submit_invoice",
  response,
);
await new Promise((resolve) => setTimeout(resolve, 20));
assert.equal(printCount, 2, "successful online submission should auto-print once");

test.scheduleDialogEdgeSuiteAutoPrint("ACC-SINV-2026-00003");
test.scheduleDialogEdgeSuiteAutoPrint("pos_offline_999");
await new Promise((resolve) => setTimeout(resolve, 20));
assert.equal(
  printCount,
  2,
  "dialog fallback must deduplicate submitted invoices and ignore local-only receipts",
);

const setupUrl = test.edgeSuitePrinterSetupUrl();
assert.match(setupUrl, /purpose=Receipt/);
assert.match(setupUrl, /product_key=retailedge/);
assert.match(setupUrl, /company=RetailEdge\+Consulting/);
assert.match(setupUrl, /branch=Ketu/);

// A connected serial port must never be assumed to be the printer bound
// to the selected profile. Switch to the saved correct port before printing.
connectedProfile = "Other Branch Receipt";
const beforeSwitchPrints = printCount;
await test.printEdgeSuiteInvoice("ACC-SINV-2026-00004");
assert.equal(disconnectCount, 1, "wrong connected port must be disconnected");
assert.equal(boundConnectCount, 1, "the requested profile must be restored");
assert.equal(printCount, beforeSwitchPrints + 1, "receipt prints after correct binding is restored");

// Even when restoration reports a connected port, a mismatched binding must
// fail closed instead of sending a different merchant's receipt to that port.
connectedProfile = "Other Branch Receipt";
forceRestoredBindingMismatch = true;
await assert.rejects(
  test.printEdgeSuiteInvoice("ACC-SINV-2026-00005"),
  (error) => error?.code === "PROCESS_EDGE_PRINTER_SETUP_REQUIRED",
);
assert.equal(printCount, beforeSwitchPrints + 1, "no receipt sent to an unmatched port");
forceRestoredBindingMismatch = false;

// A busy printer in another tab must report a recoverable conflict rather
// than opening the setup page and starting another competing serial session.
connectedProfile = null;
failSerialOwnershipHandoff = true;
await assert.rejects(
  test.printEdgeSuiteInvoice("ACC-SINV-2026-00005"),
  (error) => error?.code === "PROCESS_EDGE_PRINTER_TAB_BUSY"
    && /another browser tab/.test(error.message)
    && error.cause?.code === "SERIAL_TAB_IN_USE",
);
assert.equal(printCount, beforeSwitchPrints + 1, "blocked handoff must not print");
failSerialOwnershipHandoff = false;

// The same shared backend must preserve the wider paper layout for 80mm
// profiles and must not collapse all receipts to the 58mm variant.
configuredPaperWidth = 80;
await test.printEdgeSuiteInvoice("ACC-SINV-2026-00006");
const wideJob = printedDocuments.at(-1);
assert.equal(wideJob.document.paper, 80);
assert.equal(wideJob.document.blocks[0].text, "80mm receipt");

console.log("Executable POS EdgeSuite printing and session compatibility checks passed.");
