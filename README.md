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

[EpiKD_Experiment.py](EpiKD_Experiment.py) is the training and evaluation reference for **EpiKD**, our dengue forecaster. The job is deliberately narrow: look at the last 24 months for one district, then forecast its case count 1, 2, and 3 months ahead.

**The data.** By default it trains on an audited monthly panel covering 514 Indonesian districts (2025 BPS boundaries) across 252 months — January 2004 to December 2024, 38 provinces. Each district-month carries the reported case count, population, and climate (rainfall, minimum/maximum temperature, dry days, and the ONI El Niño index), plus fixed geography (latitude, longitude, elevation, island flag) and a shared-border adjacency matrix between districts. The panel itself is not in this repo (see *Research files and privacy* below), so by default nothing here reproduces our numbers out of the box — there's also a `--mode synthetic` fallback that generates seasonal dummy series purely to exercise the code paths, and results from that mode mean nothing epidemiologically.

Everything runs on an "as of" basis, because it's easy to accidentally cheat in forecasting. A forecast issued at month *t* only gets the information that would have been published by then, reporting delays can be simulated, all scalers and thresholds are fitted on the training period only, and the splits are locked by calendar date — fit through 2020, validate on 2021, calibrate alarm thresholds on 2022, and touch 2023–24 only for the final test. Rows are never shuffled randomly into train and test; that would leak the future straight into training.

**How it works.** Each forecast starts as a 24-month window. A month becomes a handful of features: log case counts (raw and scaled to the district's typical size), whether that month was actually observed and how stale it is, the season encoded as sine/cosine, each climate variable with its own missing-data flag, and — optionally — a population-weighted summary of what's happening in bordering districts. That sequence goes into two small blocks built around a recurrent matrix memory, borrowed from Kimi Delta Attention (KDA), a recent linear-attention design from language modelling.

The memory is the interesting part. Instead of compressing history into a single vector, each block keeps a small key→value matrix — think of it as a notebook of associations the model has picked up from past months. Every new month, the notebook first *decays*: each channel forgets at its own learned rate, so some associations fade in a month or two while others persist across seasons. Then it follows the delta rule: the model checks what the notebook currently predicts for this month's key, compares that with what actually arrived, and only writes back the *error*, scaled by a learned gate. Stale patterns get corrected precisely instead of being blindly overwritten or left to linger. A short causal convolution, gating, and a small feed-forward layer round out each block. Three separate output heads then read the final state and each produce a negative-binomial distribution (a mean μ and a dispersion κ) for one horizon — directly, without feeding predictions back in as inputs. Because the output is a full distribution rather than a point guess, the median, prediction intervals, and the probability of crossing a district's outbreak threshold all come from the same numbers. That threshold is itself learned from training data only, and there's deliberately no separate outbreak classifier that could disagree with the count forecast.

**The idea we're actually testing.** None of the ingredients are new on their own — KDA, count likelihoods, and climate features all exist. The candidate contribution is whether this kind of memory helps *here*, on short, noisy, seasonal disease series, and that's very much an open question. The hypothesis is about learning dynamics, not biology: if different channels can forget at different speeds, one model shared across all 514 districts might hold onto slow seasonal structure in some channels while reacting quickly in others when a district turns — and pooling districts might beat fitting 514 separate models when each district's usable history is short. No channel is meant to "be" a mosquito lifespan or an immunity period, and we don't claim otherwise.

So the experiment is set up to be able to prove itself wrong. EpiKD is compared against parameter-matched GRU and Transformer versions of itself (same size, same output heads, same data and features), a scalar-decay ablation that removes exactly the per-channel forgetting and nothing else, a no-convolution ablation, a LightGBM baseline, and plain seasonal-naive forecasts. Everything is scored on the same windows with proper probabilistic metrics (weighted interval score, calibration, interval coverage), plus learning curves trained on just 25%, 50%, and 75% of the history to test the low-data claim directly. If the GRU or the trees win, that's the answer — the delta memory only earns its place if it beats those controls, especially when training data is scarce.

The optional capture forecast API can serve a trained EpiKD (or the tree baseline) over uploaded monthly history, but it requires separately supplied trusted model artifacts that are not included in this source tree. It is disabled by default and has not been verified as a live service. It accepts supplied monthly history; it never uses trap counts.

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
