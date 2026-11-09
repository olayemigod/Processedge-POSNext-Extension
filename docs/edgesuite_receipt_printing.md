# EdgeSuite receipt printing on POSNext

ProcessEdge POSNext Extension can add EdgeSuite direct receipt printing to the standalone
POSNext `/pos` page without modifying POSNext core.

## Ownership

- POSNext continues to own checkout, online/offline invoice lifecycle, its browser print path,
  QZ Tray silent printing, success dialogs, and offline-local receipt printing.
- RetailEdge owns the submitted Sales Invoice receipt business payload and permissions.
- EdgeSuite owns printer profiles, browser device binding, Web Serial/Bluetooth transport,
  ESC/POS encoding, and the Devices & Printing setup page.
- ProcessEdge POSNext Extension is only the bridge between those contracts on `/pos`.

The extension never calls `navigator.serial`, `requestPort()`, `getPorts()`, or emits
ESC/POS bytes itself.

## Required platform slices

The feature expects:

1. RetailEdge shared receipt adoption, including
   `retailedge.thermal_receipt.get_thermal_receipt_payload`.
2. EdgeSuite Printing Platform plus the lightweight
   `edgeui_print.bundle.js` web runtime.
3. A configured Edge Print Profile for product `retailedge`.
4. A printer selected once in **Devices & Printing** on the same browser/device.

Because `/app` and `/pos` share the same origin, EdgeSuite's local printer binding can be
restored from the POS page after setup.

## Settings

In **ProcessEdge POSNext Settings**:

- **Enable EdgeSuite Receipt Printing** adds the EdgeSuite receipt path to POS.
- **Auto-print with EdgeSuite** prints a freshly submitted online Sales Invoice automatically.

Both settings default off.

EdgeSuite auto-print is deliberately disabled at runtime when either POSNext native
`print_receipt_on_order_complete` or POSNext `silent_print` is enabled. This prevents two
printer systems from automatically printing the same sale.

## Online checkout

For a fresh online checkout, the extension observes the successful
`pos_next.api.invoices.submit_invoice` response without modifying it. It remembers the
submitted Sales Invoice and:

- adds **Print Receipt** beside POSNext's existing **Print Invoice** action; and
- performs a non-blocking EdgeSuite auto-print when the effective auto-print policy is on.

Printer failure happens after transaction success and never changes the Sales Invoice.

## Offline checkout

Offline/local receipt printing remains POSNext-owned in this slice. Requests containing
`offline_id` are excluded from EdgeSuite auto-print observation, so a background sync cannot
unexpectedly print an old receipt when connectivity returns.

A dedicated offline EdgeSuite receipt contract can be added later if required; it should
explicitly distinguish a local provisional receipt from a submitted ERPNext receipt.

## Printer setup

If the printer profile or local device binding is missing, the POS action offers
**Devices & Printing**. The setup page stores only browser-safe local device identity; the
server profile stores policy, not browser permissions or Bluetooth device objects.

## Platform baseline and implementation decision (9 November 2026)

- Frappe v16 provides native browser printing, QZ Tray-backed raw ESC/POS printing,
  and CUPS-backed network printing. ERPNext POS Profile remains the authority for
  print format and checkout configuration. Do not duplicate those mechanisms.
  References: https://docs.frappe.io/framework/user/en/printing/raw-and-network-printing
  and https://docs.frappe.io/erpnext/pos-profile.
- Web Serial supports Bluetooth SPP/virtual COM-port devices, including paired
  receipt printers such as MPT-II. It requires a secure browser context, and an
  initial device selection requires a user gesture. A printer queue reporting
  "Driver unavailable" does not prevent a separately authorized Web Serial
  connection. Reference: https://developer.mozilla.org/en-US/docs/Web/API/Web_Serial_API.
- POSNext's QZ Tray/Windows print path and browser print fallback remain intact.
  EdgeSuite's shared ESC/POS runtime is preferred only when deliberately enabled
  and the resolved printer profile supports it. Never auto-print twice.
- A connected serial port is not enough to establish which printer is active:
  verify its saved identity against the exact resolved print profile before
  dispatch, disconnect an unmatched connection, and restore the correct bound port.
  If identity cannot be proved, fail closed and direct the operator to
  Devices & Printing. The sale stays submitted and eligible for reprint.
- The first integration slice supports submitted **online** Sales Invoice receipts.
  An offline/local POSNext receipt remains on the existing POSNext print path,
  with a clear provisional status; queued synchronization must not trigger
  surprise printing after reconnection.

## Release acceptance

1. In EdgeSuite on the same HTTPS origin and cashier browser, bind MPT-II via
   its outgoing Bluetooth serial port, then complete a physical test print.
2. With an authorized cashier and matching Company/Branch, print a submitted
   receipt from POSNext and verify the correct content and paper width.
3. Bind two different printer profiles and prove an already-connected but
   mismatched serial port is disconnected and never receives the receipt.
4. Verify missing profile, missing binding, unsupported browser, and failed
   physical writes do not change invoice or payment state.
5. Verify optional auto-print triggers once per fresh online transaction;
   legacy POSNext auto-print takes precedence, and offline delayed sync
   does not print automatically.
6. Verify cashier/manager permission scope, branch-specific receipt routing,
   reprint, light/dark visibility, and the POSNext browser/QZ fallback.
7. Deploy only after the exact-head CI and real-device, cashier-persona checks
   pass on an isolated site; no production changes are implied by this PR.
