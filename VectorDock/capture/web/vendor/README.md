Vendored QR decoder (browser runtime dependency, pinned):

- library: jsqr 1.4.0 (MIT)
- source: https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js
- files: jsQR.js (UMD build), jsQR.LICENSE (MIT license text)
- loaded in the page with `<script src="vendor/jsQR.js"></script>` (local file,
  no CDN at runtime) and used through `globalThis.jsQR` from
  `js/lib/qr-decoder.js`.
- It is a dedicated QR decoder. SAM3 is never used for QR decoding, and the
  experimental `BarcodeDetector` API is not a required path.

Pin note: re-vendoring must copy the exact versioned artifact and update this
note and the LICENSE.
