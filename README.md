# ProcessEdge POSNext Override

App-level POSNext customizations for ERPNext/Frappe that keep upgrade risk low by avoiding core edits.

## Features

- Global setting to allow editable selling price on POS
- Global setting to allow editable posting date on POS
- Per-profile opt-out for rate editing through POSNext POS Settings when the global rate toggle is enabled
- Sync layer that maps app settings to POSNext's native POS Settings fields
- POS page runtime patch for posting date UI and invoice payload injection
- Backend validation guard for POS invoice posting date changes
- Optional RetailEdge Cashier Expense action inside POSNext without POSNext core edits
- Responsive Cashier Expense modal with server-side category search, active-shift context, and idempotent submission
- Script Report: `POS Closing Variance vs Expenses`

## Target Stack

- Frappe / ERPNext v16
- POSNext `develop` branch reference

## Installation

```bash
cd /path/to/frappe-bench
bench get-app https://github.com/olayemigod/Processedge-POSNext-Extension.git
bench --site your-site install-app processedge_posnext_override
bench --site your-site migrate
bench build --app processedge_posnext_override
bench --site your-site clear-cache
```

If POSNext is already installed, keep it installed and rebuild both apps when needed:

```bash
bench build --app pos_next --app processedge_posnext_override
```

## Configuration

1. Open `ProcessEdge POSNext Settings` in Desk.
2. Toggle:
   - `Allow Editable Selling Price on POS`
   - `Allow Editing Posting Date on POS`
3. Save the document.
4. Reload the POS screen.

The app automatically syncs these settings into POSNext's `POS Settings` records so existing POSNext frontend and backend behavior can keep using their native fields.

### RetailEdge Cashier Expense bridge

When RetailEdge is installed and **Enable Cashier Expense in POS** is enabled in RetailEdge Settings, the POS screen exposes a **Cashier Expense** action. Desktop POS uses the management sidebar; smaller layouts use a floating action.

The extension is only the presentation bridge. RetailEdge remains authoritative for:

- Company, Branch, POS Profile and active opening shift
- Cashier identity and permission scope
- Expense Category and Expense Account resolution
- Available till cash validation
- Controlled Posting versus Direct Posting policy
- Accounting posting and POS closing treatment

The extension does not make RetailEdge a hard dependency. On sites where RetailEdge or its POS expense API is unavailable, the Cashier Expense action is simply not shown.

The POS modal performs bounded server-side Expense Category search and sends a unique client request ID with every expense so retries cannot create duplicate till expenses.

## How It Works

- `ProcessEdge POSNext Settings` is the source of truth.
- The global selling-price toggle acts as a master switch.
- When the global selling-price toggle is enabled, each POS Settings record can still disable `allow_user_to_edit_rate` for its own profile.
- The app mirrors flags into POSNext `POS Settings`:
  - `allow_user_to_edit_rate`
  - `allow_change_posting_date`
- The POS page script adds a posting date field in the checkout dialog and injects the chosen date into POSNext invoice requests.
- Sales Invoice validation prevents custom posting dates when the feature is disabled.

## Files Of Interest

- `processedge_posnext_override/hooks.py`
- `processedge_posnext_override/api.py`
- `processedge_posnext_override/overrides/pos_settings.py`
- `processedge_posnext_override/overrides/sales_invoice.py`
- `processedge_posnext_override/public/js/processedge_posnext_override.js`
- `processedge_posnext_override/api.py` — optional RetailEdge Cashier Expense bridge

## Validation Checklist

- Open POS and confirm rate field is read-only when disabled.
- Enable selling price editing and confirm Edit Item dialog rate field is editable.
- Enable posting date editing and confirm checkout dialog shows a posting date field.
- Submit a POS invoice and confirm the selected posting date is stored on the Sales Invoice.
- Run `POS Closing Variance vs Expenses` and confirm shortages are compared with same-day expense GL entries.
- With RetailEdge installed, enable Cashier Expense in POS and confirm the action appears only for an eligible POS user/shift.
- Record a Cashier Expense and confirm the RetailEdge record carries the correct Branch, POS Profile, opening shift and cashier.
- Retry the same request ID and confirm no duplicate expense is created.
- Confirm POS closing reflects the submitted/disbursed RetailEdge till expense exactly once.

## POS Closing Variance vs Expenses Report

The report compares submitted POSNext `POS Closing Shift` variances with net expense GL entries for the same posting date and company. If an `Expense Cost Center` filter is not selected, the report uses the POS Profile cost center when that field exists.

Use this to review whether POS shortages at a business location are supported by expenses booked for the same location and date.

## Suggested Repository Metadata

- Repository name: `Processedge-POSNext-Extension`
- Description: `ERPNext v16 custom app for POSNext price-edit and posting-date controls without core edits.`
