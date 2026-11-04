# VectorDock capture

The capture app lets an authorized operator identify a trap, select a sample, upload a photo, and review a SAM3 candidate count. The backend records uploads and jobs before requesting the counter. A QR code identifies a trap; it does not authorize access.

## Local setup on Windows

These commands create a local, test-only SQLite database. They do not use the deployed system. Install Python and Node.js 22 or newer first.

In a PowerShell window, from this repository's root:

```powershell
cd VectorDock/capture/backend
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
New-Item -ItemType Directory -Force data | Out-Null
$env:CAPTURE_ENV = "development"
$env:CAPTURE_MODAL_ENABLED = "0"
$env:CAPTURE_ALLOWED_ORIGINS = "http://127.0.0.1:8788"
$env:CAPTURE_PUBLIC_BASE_URL = "http://127.0.0.1:8788"
$env:CAPTURE_SESSION_SECRET = "local-only-session-example-1234567890"
$env:CAPTURE_RELAY_TOKEN = "local-only-relay-example-123456789012"
.\.venv\Scripts\python.exe -m app.cli seed-fixtures --show-passwords
.\.venv\Scripts\python.exe -m uvicorn app.main:create_app --factory --host 127.0.0.1 --port 8765
```

Save the displayed test credentials. The fixture command creates `test-worker`, `test-reviewer`, and trap `VD-TEST-001`. Run it only for the first local setup: it does not replace passwords for existing accounts.

In a second PowerShell window, from the repository root:

```powershell
cd VectorDock/capture/web
$env:CAPTURE_BACKEND_ORIGIN = "http://127.0.0.1:8765"
$env:CAPTURE_RELAY_TOKEN = "local-only-relay-example-123456789012"
node dev-server.mjs 8788
```

Open [http://127.0.0.1:8788](http://127.0.0.1:8788) on the same computer. The example secrets are for loopback testing only. Do not use them in production.

The local adapter is disabled. An uploaded test image can be stored, but the counting job fails without a configured counter. It must not be treated as a completed count. Local databases and photos stay in the ignored backend `data/` directory.

To try the separate forecast form locally, install `backend/requirements-forecast.txt` in the same virtual environment and set `CAPTURE_FORECAST_RUNTIME=local` before starting the backend. The form requires 24 months of supplied case and climate history. These research forecasts do not use trap counts.

## Hosted components

The deployment uses a Cloudflare Pages relay, a Modal CPU capture API, PostgreSQL metadata, a dedicated Modal capture volume, and a separate Modal SAM3 GPU service. Configure `CAPTURE_BACKEND_ORIGIN` and the relay token on the server; never put secrets in browser code. Production also requires a session secret, allowed origins, a public base URL, and a dedicated volume.

The current SAM3 service stores a second image and result copy in its output volume. Production requires an explicit archive opt-in. Establish access, retention, and deletion rules for both stores before enabling uploads. GPU calls may incur charges.

## Limits

SAM3 outputs candidate detections, not verified counts. A reviewer must accept, correct, or reject them. Test traps and samples are not field measurements. The optional district forecast API is disabled by default and does not consume trap counts.
