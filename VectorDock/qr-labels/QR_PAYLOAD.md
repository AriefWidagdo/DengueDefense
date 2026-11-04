# Container identity in a capture photo

The operator requests one photograph that includes the collection surface and the container QR. The capture page reads the QR from the same selected or camera-captured photograph. It resolves the container through the authorized registry before the worker confirms the sample and upload. SAM3 counts candidate objects; it does not read QR codes.

## Preferred printed payload

```text
VD1:TRAP:VD-001
```

`VD1:TRAP:` is the literal versioned prefix. The remainder is the container's `trap_id`. The local label maker uses 2–40 uppercase ASCII letters, digits and hyphens, starting with a letter or digit. It prints no location, deployment date, credential or sample ID inside this mode's QR. Human-readable site and deployment details remain outside the QR on the label. The container ID stays the same when the card/strip changes.

This is an identifier token, not a URL. It does not open an upload website from a native camera. The VectorDock capture page must decode it from the photo. Printing it does not register a container in the backend. Register or import the matching ID and active deployment before operational use. The local label list is not the backend registry.

## Existing label compatibility

The first local label tool also prints `details` QR payloads. They begin with the exact line `VECTORDOCK CONTAINER` and include exactly one `ID: <trap_id>` line. A capture decoder may extract that ID. It must ignore the location/date text as authority and resolve the current authorized registry record. Reject malformed or conflicting ID lines.

The backend QR CLI also emits `{configured_origin}/capture?trap=<trap_id>`. Accept only the configured application origin and intended capture path, or a documented local development origin. Do not navigate to arbitrary URLs from QR content. Reject duplicated/conflicting trap query parameters.

**Maps-only QRs have no container ID and cannot identify a container automatically.** Keep Maps mode as an explicit location-only utility, not as the recommended capture label.

## Capture behavior

- Provide separate **Take picture** and **Upload photo** controls. Both feed the same photo-preview and QR-decoding path.
- Decode locally with a dedicated QR decoder. Do not depend only on the experimental `BarcodeDetector` API without a supported fallback.
- Show the resolved container ID and registry site/location before upload. QR content grants no permission.
- Reject unknown or unauthorized IDs. Do not reveal a private location before authorization.
- Do not choose silently between different readable container IDs. Show a conflict if the photo disagrees with an already selected container or sample.
- If no QR can be read, request a retake or explicit manual selection/confirmation. Never guess a location or silently reuse a previous container.
- A container QR does not identify the exposure sample or distinguish adult-card vs egg-strip. Preserve sample selection, exposure metadata, image-retake identity and final photo confirmation.
- Keep the original image and existing provenance rules. Reading a QR must not accept a candidate count, set `available_at`, or trigger duplicate inference.

For field capture, place a clear, dry label beside the collection surface. Keep the entire QR and its white border in the image. The framing must still resolve the mosquitoes or eggs; an actual phone/print test remains required.
