import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = await readFile(
  new URL("../public/js/processedge_posnext_override.js", import.meta.url),
  "utf8",
);

let printCount = 0;
const printedDocuments = [];
const adapter = {
  getStatus() {
    return { connected: true, state: "connected" };
  },
  devices: {
    async connectBoundSerial() {
      return { status: { connected: true, state: "connected" } };
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
        paper: 58,
        charactersPerLine: 32,
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
    clone() {
      return jsonResponse(message);
    },
  };
}

const windowObject = {
  __PROCESS_EDGE_POSNEXT_TEST_MODE__: true,
  processedgePosnextOverrideInitialized: false,
  location: { pathname: "/pos", hostname: "retail.local" },
  EdgeSuitePrint: adapter,
  setTimeout,
  requestAnimationFrame: (fn) => fn(),
  open: () => ({}),
  confirm: () => false,
};
windowObject.fetch = async (url) => {
  if (String(url).includes("get_edgesuite_receipt_print_payload")) {
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
        blocks: [{ type: "text", text: "Receipt" }],
      },
    });
  }
  throw new Error(`Unexpected fetch URL: ${url}`);
};

const context = vm.createContext({
  window: windowObject,
  document: {},
  console,
  URLSearchParams,
  FormData: globalThis.FormData,
  TextEncoder,
  setTimeout,
  clearTimeout,
});
vm.runInContext(source, context, { filename: "processedge_posnext_override.js" });

const test = windowObject.__ProcessEdgePOSNextPrintingTest;
assert.ok(test, "test seam should be exposed in explicit test mode");
test.state.settings = {
  edgesuite_receipt_printing_enabled: 1,
  edgesuite_printing_available: 1,
  edgesuite_auto_print_effective: 1,
  company: "RetailEdge Consulting",
  branch: "Ketu",
};

assert.deepEqual(
  test.submittedInvoiceFromResponse({
    message: {
      name: "ACC-SINV-2026-00001",
      doctype: "Sales Invoice",
      company: "RetailEdge Consulting",
      branch: "Ketu",
    },
  }),
  {
    name: "ACC-SINV-2026-00001",
    doctype: "Sales Invoice",
    company: "RetailEdge Consulting",
    branch: "Ketu",
  },
);

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

console.log("Executable POS EdgeSuite printing bridge runtime checks passed.");
