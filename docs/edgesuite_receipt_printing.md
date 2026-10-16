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
