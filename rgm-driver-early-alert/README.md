# RGM Driver Early Alert (R4G + Dockmaster + FMC)

A Tampermonkey userscript that checks arrival-time information for gate transactions and displays an alert when a driver appears to have arrived earlier than the relevant scheduled time.

The script is designed to coordinate three web applications:

- **R4G / Sesame Gate Console** — scans gate transaction rows and reads the site's local time.
- **Dockmaster** — checks arrival details for Vendor Inbound ISA appointments.
- **FMC** — checks Planned Dock Arrival for VRID / box-truck loads.

> **Status: Experimental — v0.1.0.** The source comments state that this version was built from screenshots rather than live DOM inspection. Its label-based page parsing and cross-application flow must be verified in an approved environment before operational use.

## Features

- Scans R4G gate transaction rows for ISA and VRID links.
- Opens the existing Dockmaster link for an ISA transaction.
- Opens the existing FMC link for a VRID transaction.
- Passes a request ID through the URL so the result can be matched to the original R4G row.
- Reads arrival-time fields from Dockmaster or FMC and shares results between tabs using Tampermonkey value storage.
- Compares the returned arrival time against the site's local time read from R4G.
- Shows a modal alert when the configured early-arrival condition is met.
- Displays a one-time notice explaining the popup requirement.

## How the flow works

1. **R4G scans gate rows.** It looks for the `VRID/ISA/PO#` and `Load type` columns.
2. **ISA transaction:** the script opens the ISA link with an `rgmReq` tracking parameter so Dockmaster can return the appointment arrival details.
3. **VRID transaction:** the script opens the VRID link with `rgmReq` and `rgmSite` parameters so FMC can return the Planned Dock Arrival for the matching site.
4. **Dockmaster or FMC reads visible page text.** It waits for expected labels or table content and writes the result into Tampermonkey shared storage.
5. **R4G receives the result.** It compares the returned time with the site's local time and displays an alert when the configured threshold is exceeded.

## Early-arrival rules in v0.1.0

| Load type | Time source | Alert condition |
|---|---|---|
| Vendor Inbound — LIVE | Dockmaster `Expected Arrival Date` | More than 30 minutes early |
| Vendor Inbound — DROP | Dockmaster `Earliest Arrival Time` | Any amount early |
| Box truck / VRID | FMC `Planned Dock Arrival` | More than 30 minutes early |

The 30-minute threshold is configured by `LIVE_EARLY_THRESHOLD_MIN`. In this version, the same threshold is used for LIVE loads and VRID / box-truck loads.

## Requirements

- A supported browser such as Chrome or Microsoft Edge.
- A userscript manager that supports the `GM_*` APIs, such as Tampermonkey.
- Authorized access to the R4G Sesame Gate Console, Dockmaster, and FMC pages.
- Browser popup permission for the relevant sites.
- Organizational approval to use and share this script.

## Installation

1. Install Tampermonkey from [tampermonkey.net](https://www.tampermonkey.net/).
2. Open the Tampermonkey dashboard and create a new userscript.
3. Copy the contents of `rgm-driver-early-alert.user.js` into the editor.
4. Save the script and ensure it is enabled.
5. Confirm that the script's URL match rules cover the intended applications.
6. In an approved test environment, verify that the labels and table structure match the assumptions in the script.

### Popup permission

The script calls `window.open()` to open Dockmaster or FMC in a background tab. The source includes a one-time notice that popups must be allowed for the relevant domains. If the browser blocks these opens, the cross-application check may not complete.

## Supported URL patterns

The userscript metadata currently includes these patterns:

- `https://trans-logistics.amazon.com/yms/sesameGateConsole*`
- `https://trans-logistics.amazon.com/fmc/execution/search/*`
- `https://prod-na.us-east-1.idx-website.aft.amazon.dev/en_US/*/appointment/view/*/appointmentDetail*`

The script uses the R4G URL hash containing `relayGate` to identify the R4G page.

## Configuration

| Constant | Purpose |
|---|---|
| `RESULT_KEY` | Shared Tampermonkey storage key for results returned from Dockmaster and FMC. |
| `SEEN_KEY_PREFIX` | Prefix used in `sessionStorage` to avoid repeatedly processing the same row during a session. |
| `LIVE_EARLY_THRESHOLD_MIN` | Early-arrival threshold in minutes for LIVE loads and VRID / box-truck loads. |
| `POPUP_NOTICE_KEY` | Storage key for the one-time popup-permission notice. |

The current version uses visible label text such as `Load type`, `VRID/ISA/PO#`, `Earliest Arrival Time`, `Expected Arrival Date`, and `Planned Dock`. If the applications change these labels or their DOM structure, the script may need updating.

## Manual test checklist

Use an approved test environment and do not dismiss or alter live operational transactions for testing.

- [ ] The script loads on each intended application page.
- [ ] R4G's page is correctly identified when the `relayGate` hash is present.
- [ ] The script finds the correct gate table and header columns.
- [ ] ISA rows open the intended Dockmaster appointment link.
- [ ] VRID rows open the intended FMC link with the correct site code.
- [ ] Dockmaster's load type and arrival fields are read correctly.
- [ ] FMC's matching site row and Planned Dock Arrival are read correctly.
- [ ] The returned result is associated with the correct R4G request.
- [ ] R4G's site-local time is parsed correctly.
- [ ] Alerts match the configured thresholds.
- [ ] Popup blocking and missing-field cases fail visibly and safely.
- [ ] The script is retested after application UI changes.

## Known limitations and risks

- **DOM assumptions are unverified:** the source explicitly says it was built from screenshots, not live DOM inspection.
- **Text-based parsing:** labels and table text are used instead of stable application selectors.
- **Time parsing:** the parser supports only certain date/time formats. Unsupported or ambiguous formats may not be parsed.
- **Popup dependency:** browser settings can block `window.open()`.
- **Client-side only:** this script does not query authoritative backend APIs or independently verify a vehicle's physical presence.
- **Operational false positives/negatives:** incorrect row matching, stale page data, timezone assumptions, or UI changes could lead to incorrect alerts or missed alerts.
- **No guarantee of coverage:** the script may not detect every relevant load or every way a page is rendered.

Treat alerts as an aid for review, not as authoritative operational decisions. Verify the appointment and follow the site's official process.

## Troubleshooting

### No Dockmaster or FMC tab opens
Check that the userscript is enabled and popup permissions are configured for the relevant sites. Also confirm that the row contains the expected ISA or VRID link.

### No alert appears
Verify that the page contains the expected labels and table headers, that the arrival field is readable, and that the returned time meets the configured threshold. Check the browser console for errors.

### Arrival time is missing or incorrect
The source parser relies on specific visible labels and date formats. Compare the live page's displayed values with the formats supported by `parseWallClock()`.

### It stopped working after a UI change
Re-check the current DOM structure and visible labels in an approved environment. Update the detection logic only after confirming the correct row and field mapping.

## Privacy and security

The script is configured to coordinate results through Tampermonkey's shared value storage and tracking query parameters. Review the source before installation. Do not add credentials, tokens, or external data collection. Avoid posting internal operational data, appointment identifiers, screenshots, or sensitive URLs in public issue trackers.

## Contributing

Before contributing, confirm that you are authorized to share changes. Include a clear summary and test notes, and do not include confidential operational details.

## Disclaimer

This is an experimental userscript and is not an official product unless formally approved and maintained by the relevant organization. Use only in authorized environments and in accordance with applicable company policies. It does not replace official operating procedures or authoritative system checks.

## License

No license is specified by the original source file. Add a license only after confirming you have the right to publish and license the code.
