# Dengue Defense — Epi-Pipeline

A dengue hackathon prototype in 3 parts: **the trap, the model, and the game**.

```text
Trap photo → capture app → SAM3 on Modal → candidate count → human review

EpiKD model + historical inputs → dengue forecast → decision game
```

The capture system stores the photo and requests a SAM3 counting job. A reviewer can accept, correct, or reject the candidate result. The game runs a trained EpiKD model in the browser and uses its forecasts in a simulated campaign.

**The two lines above are not connected:** trap counts do not enter the current EpiKD model or game. Counting accuracy and forecast performance in the field have not been established. Game intervention effects are rules, not model estimates.

The [hosted capture demo](https://vectordock-capture.pages.dev/) requires an authorized account. Its current `BUCK1` setup is a test fixture.

### Demo Credentials (Hosted Capture App)

For demo and evaluation purposes, you can sign in to the [hosted capture demo](https://vectordock-capture.pages.dev/) with:

- **Username:** `operator`
- **Password:** `abcd12345678`

## Play the game locally

Install Node.js 22.5 or newer, then run:

```bash
cd MainGame
node dev-server.mjs
```

Open [http://127.0.0.1:4173](http://127.0.0.1:4173) on the same computer. The local leaderboard uses an in-memory database. Scores disappear when the server stops.

## Run the capture app locally

See [the capture setup](VectorDock/capture/README.md) for the backend and phone interface. The local setup uses test identities and a test trap. It does not contact Modal; counting jobs fail rather than produce a fake result.

A live counting setup requires a database, a dedicated capture volume, a deployed SAM3 service, its separately supplied checkpoint, and private server-side credentials. See [the SAM3 notes](SAM3/README.md). The model checkpoint and cloud credentials are not included in this repository.

## The 3 parts

### 1. The trap

- [VectorDock/capture/](VectorDock/capture/) — phone interface, capture API, processing jobs, and human review.
- [VectorDock/qr-labels/](VectorDock/qr-labels/) — local tool for printing trap labels.
- [SAM3/](SAM3/) — Modal object-counter source and command-line client.

### 2. The model

- [EpiKD_Experiment.py](EpiKD_Experiment.py) — EpiKD training and evaluation reference, with a synthetic-data mode.
- The optional capture forecast API requires separately supplied trusted model artifacts. Those generated exports are not included in the current source tree.

The optional forecast API is disabled by default and has not been verified as a live service. It accepts supplied monthly history; it does not use trap counts.

### 3. The game

- [MainGame/](MainGame/) — the working game, local test server, deployment copy, and leaderboard Worker.
- The game contains its own trained model and historical demo inputs in its HTML. It does not need the removed experiment exports. The game source and deployment copy remain unchanged.

## Research files and privacy

The top-level `data/` and `outputs_epikd_*/` directories are excluded from Git. Keep research inputs, training outputs, captured photos, local databases, and credentials outside the public source tree. The QR test images are generated fixtures, not field photos.

**The game still embeds historical demo inputs.** Removing those inputs requires a separate game change. Removing files from the current source tree also does not remove copies from older commits.

## Checks

From `VectorDock/capture/backend`, create a Python virtual environment, install `requirements.txt`, and run `python -m pytest tests -q`. Tests that need the omitted research dataset or optional forecast dependencies skip when they are unavailable.

From `MainGame`, run `python -m unittest discover -s tests -v`. The game browser tests require Playwright with Chromium and Node.js 22.5 or newer.

Cloud configuration files retain project-specific resource names, a database ID, and public service addresses. Check them before deploying to avoid changing existing resources. Keep secrets outside this repository.
