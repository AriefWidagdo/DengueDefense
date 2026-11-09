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

I built **EpiKD** for one narrow job: I give it the last 24 months for a district, and it forecasts that district's case count 1, 2, and 3 months ahead. [EpiKD_Experiment.py](EpiKD_Experiment.py) is where I train and evaluate it.

**The data I use.** I train on an audited monthly panel I put together covering 514 Indonesian districts (2025 BPS boundaries) across 252 months — January 2004 to December 2024, 38 provinces. For each district-month I have the reported case count, population, and climate (rainfall, minimum/maximum temperature, dry days, and the ONI El Niño index), plus fixed geography (latitude, longitude, elevation, island flag) and a shared-border adjacency matrix between districts. I don't include that panel in this repo (see *Research files and privacy* below), so you can't reproduce my numbers just by cloning this. I also left in a `--mode synthetic` fallback that generates seasonal dummy series. I only use it to check that the code runs end to end; I never treat results from it as evidence of anything.

I run everything on an "as of" basis, because I found it way too easy to accidentally cheat at forecasting. If I issue a forecast at month *t*, I only let it see what would actually have been published by then, I can simulate reporting delays, and I fit every scaler and threshold on the training period only. I lock my splits by calendar date — I fit through 2020, validate on 2021, calibrate my alarm thresholds on 2022, and I only touch 2023–24 for the final test. I never shuffle rows randomly into train and test, because that leaks the future straight into training and makes the scores look better than they are.

**How I built it.** I turn each forecast into a 24-month window. I represent a month with a handful of features: log case counts (raw, and scaled to the district's typical size), whether I actually observed that month and how stale it is, the season as sine/cosine, each climate variable with its own missing-data flag, and — if I turn the spatial option on — a population-weighted summary of what's happening in bordering districts. I feed that sequence into two small blocks built around a recurrent matrix memory, which I borrowed from Kimi Delta Attention (KDA), a recent linear-attention design from language modelling.

The memory is the part I actually care about. Instead of compressing history into a single vector, I have each block keep a small key→value matrix — I think of it as a notebook of associations it has picked up from past months. Every new month, I first let the notebook *decay*: each channel forgets at its own learned rate, so some associations fade in a month or two while others stick around across seasons. Then I apply the delta rule: I check what the notebook currently predicts for this month's key, I compare it with what actually arrived, and I only write back the *error*, scaled by a learned gate. That way I correct stale patterns precisely instead of blindly overwriting them or leaving them to linger. I round each block out with a short causal convolution, gating, and a small feed-forward layer. Finally, I use three separate output heads that read the final state and each give me a negative-binomial distribution (a mean μ and a dispersion κ) for one horizon — directly, without feeding my own predictions back in as inputs. Because I get a full distribution rather than a point guess, I can pull the median, my prediction intervals, and the probability of crossing a district's outbreak threshold from the same numbers. I learn that threshold from training data only, and I deliberately didn't bolt on a separate outbreak classifier that could end up disagreeing with my own count forecast.

**The idea I'm testing.** I want to be straight about this: none of the ingredients are new on their own. KDA exists, count likelihoods exist, climate features exist. What I don't know yet — and what I'm testing — is whether this kind of memory actually helps *here*, on short, noisy, seasonal disease series. My hypothesis is about learning dynamics, not biology: if I let different channels forget at different speeds, a single model I share across all 514 districts might hold onto slow seasonal structure in some channels while reacting quickly in others when a district turns, and pooling all my districts together might beat fitting 514 separate models when each district's usable history is short. I'm not claiming a channel "is" a mosquito lifespan or an immunity period — I have no evidence for that, and I don't read it that way.

So I set the experiment up to be able to prove myself wrong. I compare EpiKD against parameter-matched GRU and Transformer versions of itself (same size, same output heads, same data and features), a scalar-decay ablation where I remove exactly the per-channel forgetting and nothing else, a no-convolution ablation, a LightGBM baseline, and plain seasonal-naive forecasts. I score all of them on the same windows with proper probabilistic metrics (weighted interval score, calibration, interval coverage), and I run learning curves where I only give them 25%, 50%, and 75% of the history, because that's the low-data claim I actually want to test. If the GRU or the trees beat me, then that's the answer — I only keep the delta memory if it earns its place against those controls, especially when I starve it of training data.

I also wired up an optional forecast API in the capture app that can serve a trained EpiKD (or my tree baseline) over monthly history you upload, but it needs trusted model artifacts that I supply separately and don't include in this source tree. I keep it disabled by default and I haven't verified it as a live service. It takes the monthly history I give it; it never touches trap counts.

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
