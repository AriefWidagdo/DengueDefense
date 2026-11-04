# Local VectorDock QR label maker

Run this tool without Modal, a database, or the capture application:

```bash
python -m http.server 8788 --bind 127.0.0.1 --directory VectorDock/qr-labels
```

Run from the repository root. Open <http://127.0.0.1:8788/>.

Enter a unique container ID, site, exact placement and deployment date. GPS, next service date, container setup and placement note are optional. Save several labels or print the current label. Use 100% / Actual size. Disable browser print headers and footers. The QR is 48 mm square, including its white border, at the specified print size. Labels have a dashed cut line. A4 printing uses 2 columns.

## QR modes

- **Bucket ID (recommended):** stores a short versioned identifier such as `VD1:TRAP:VD-001`. Include the QR in the same photo as the collection surface. The capture app reads the ID and resolves the authorized registry location. The code does not encode changing dates or locations. It does not open a website. Printing or saving it here does not register the bucket in the backend. See [QR_PAYLOAD.md](QR_PAYLOAD.md) for the shared capture contract.
- **Details:** stores a text snapshot inside the QR. No hosted site or network is required to read it with a QR reader that displays text. Some native camera applications handle URL QR codes better than text. Test the actual phone and printed label before placement. A change to the details requires a new printed label.
- **Maps:** stores a Google Maps HTTPS search URL. GPS takes precedence over the written location. Without GPS, Maps searches the location and site text; check the resolved location. This QR opens only the location. It has no bucket ID and cannot automatically assign a capture photo. Deployment and service dates remain printed text. Google receives the location when someone opens the link. A connection is required.

None of these modes points to an upload app. This tool does not imply that the Cloudflare capture site is deployed. `localhost` addresses are not encoded in these QR codes, so leaving the computer's network does not break a details QR. A future stable capture-site QR is a separate URL mode in the capture application.

## Records and privacy

The label belongs to the physical container, not to a card/strip exposure. Keep the same container ID for replacement samples. Do not reuse an ID on a different container.

Drafts and the saved label list use this browser's local storage. The tool has no server-side registry, cross-device sync, sign-in, analytics or upload. Clearing browser storage removes the list. Export JSON to keep a copy. The export is a local-label record, not a confirmed deployment in the future backend.

Anyone who scans a QR can read its contents. Bucket ID mode exposes only the identifier inside the QR; the paper still shows its printed site and dates. Anyone who scans a details QR can read the full snapshot. Do not include personal details, private access instructions or secrets. Anyone who sees a printed label can read its location. All QR generation runs locally through the vendored `qrcode-generator` 1.4.4 library. No third-party QR generation API runs.

## Local checks

```bash
node --test VectorDock/qr-labels/tests/labels.test.cjs
# With the local server running, Playwright Chromium and OpenCV installed:
python VectorDock/qr-labels/tests/browser_smoke.py
```

The browser check uses an isolated test-only context. It decodes both QR modes, checks browser storage, validates form errors, checks mobile overflow and exports a test PDF. It does not send a physical print job.

The capture backend and page are in `VectorDock/capture/`. This tool does not change SAM3, existing Volumes, models or forecast artifacts.
