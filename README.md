# Dengue Defense (Epi-Pipeline)

This is my dengue hackathon project. It is built in three parts: **the mosquito trap, the forecasting model, and the decision game**.

```text
Trap photo -> capture app -> SAM3 on Modal -> candidate count -> human review

EpiKD model + historical inputs -> dengue forecast -> decision game
```

Here is the basic flow:
1. **The Trap & Capture App:** You take a photo of a mosquito trap on your phone. The app saves the photo and sends it to a SAM3 vision job running on Modal to count the mosquitoes/eggs. A human reviewer can then accept, tweak, or reject that count.
2. **The Model & Game:** The game runs a trained **EpiKD** forecasting model directly in the browser, using real historical data to generate dengue forecasts across a simulated campaign.

One quick heads-up before diving in: **those two pipelines aren't wired together yet.** The trap counts from the phone app don't feed into the current EpiKD model or the game. Field accuracy for the counter and real-world forecast performance haven't been proven out in production either, and the intervention effects inside the game are game rules rather than learned causal estimates.

### Demo Credentials (Hosted Capture App)

If you want to try the [hosted capture demo](https://vectordock-capture.pages.dev/) for evaluation, you can log in with:

- **Username:** `operator`
- **Password:** `abcd12345678`

*(Note: The current `BUCK1` trap setup on the live demo is just a test fixture.)*

---

## How to run things locally

### Play the game locally

You'll need Node.js 22.5 or newer. Run:

```bash
cd MainGame
node dev-server.mjs
```

Then open [http://127.0.0.1:4173](http://127.0.0.1:4173) in your browser. The local leaderboard uses an in-memory database, so scores wipe whenever you stop the server.

### Run the capture app locally

Check out [VectorDock/capture/README.md](VectorDock/capture/README.md) for how to spin up the backend and phone UI. The local dev setup uses dummy accounts and a test trap. It does not talk to Modal by default, so counting jobs will fail cleanly instead of making up fake numbers.

If you want live counting to work, you need a database, a storage volume, a deployed SAM3 service with its model checkpoint, and private server credentials. See [SAM3/README.md](SAM3/README.md) for details (the heavy checkpoints and cloud keys aren't committed to this repo).

---

## Breakdown of the 3 parts

### 1. The Trap

- [VectorDock/capture/](VectorDock/capture/) - The mobile web UI, backend API, job queue, and human review screen.
- [VectorDock/qr-labels/](VectorDock/qr-labels/) - A small utility for printing QR code labels to stick on physical traps.
- [SAM3/](SAM3/) - The Modal object-counting service and CLI client.

### 2. The Model (EpiKD)

I built **EpiKD** to do one specific job: you hand it the last 24 months of data for a district, and it predicts that district's dengue case counts 1, 2, and 3 months into the future. All the training and evaluation code lives in [EpiKD_Experiment.py](EpiKD_Experiment.py).

#### What data it uses
I trained the model on an audited monthly dataset I put together covering all 514 districts in Indonesia (using 2025 BPS boundaries) over 21 years — 252 months from January 2004 to December 2024 across 38 provinces. For every district and month, it tracks:
- Reported dengue cases and population size
- Climate numbers: rainfall, min/max temperature, dry days, and the ONI El Nino index
- Static geography: latitude, longitude, elevation, whether it's on an island, and a border-adjacency map showing which districts touch each other

That raw dataset isn't in this public repo (see the privacy section at the bottom), so cloning the repo won't reproduce my exact paper numbers out of the box. However, I included a `--mode synthetic` flag that generates seasonal dummy data so anyone can run the training pipeline end-to-end and verify the code works.

#### Keeping the evaluation honest (no time-travel cheating)
It is super easy to accidentally cheat in time-series forecasting, so I set everything up on a strict "as of" timeline. When the model makes a forcast at month *t*, it only sees data that would have actually been available at that moment (including simulated reporting delays). Every scaler and outbreak threshold is fit strictly on the training split:
- **Train:** up through 2020
- **Validation:** 2021
- **Threshold calibration:** 2022
- **Final test:** 2023-2024

I never shuffle rows randomly between train and test, because doing that leaks future outbreak patterns backward and inflates the scores.

#### How the architecture works (in plain English)
For each prediction, the model looks at a 24-month sliding window. Each month is represented by a bundle of features: log case counts (both raw and scaled to that district's normal baseline), whether the data for that month was actually observed or is stale, sine/cosine waves for the time of year, climate variables (with missing-data flags), and an optional population-weighted summary of neighboring districts.

That 24-month sequence passes through two small neural blocks built around a recurrent matrix memory borrowed from **Kimi Delta Attention (KDA)**, which comes from recent linear-attention research in language models.

Here is why I used that memory setup instead of a standard recurrent vector:
- **A "notebook" instead of a single squished vector:** Each block keeps a small key-to-value matrix, kind of like a scratchpad of patterns it has noticed over past months.
- **Different forgetting speeds:** Every time a new month comes in, the scratchpad decays first. Each channel learns its own decay rate, so some channels can forget short-term noise in a month or two while other channels hold onto multi-season trends.
- **The Delta Rule (only writing down the surprise):** Before updating the memory, the model checks what its scratchpad *already* expects for the new month and compares it to what actually happened. It only writes back the **error** (the difference), scaled by a learned gate. That lets it fix stale assumptions cleanly instead of blindly overwriting old memory.

After a short causal convolution and feed-forward layer, three seperate output heads read the final state to predict 1, 2, and 3 months ahead all at once (instead of feeding predictions back into itself one month at a time).

Instead of spitting out a single number, each head outputs a full **Negative Binomial distribution** (a mean $\mu$ and dispersion $\kappa$). Having a full probability distribution means I can pull the median case forecast, the uncertainty intervals (like 10th to 90th percentile), and the exact probability of crossing a local outbreak threshold all from the same output — without needing a second classifier model that might contradict the case count model.

#### What I'm actually testing here
To be totally upfront: none of these building blocks are brand new inventions on their own. KDA exists, negative binomial count models exist, and climate features are standard. What I wanted to test is whether this specific type of delta memory actually helps on short, noisy, highly seasonal disease data.

My hypothesis is about how the model learns when data is scarce: by pooling all 514 districts together and letting different memory channels forget at different speeds, one shared model might keep slow seasonal rhythms in some channels while reacting fast to sudden local spikes in others.

To make sure I'm not fooling myself, I benchmark EpiKD against tough controls in [EpiKD_Experiment.py](EpiKD_Experiment.py):
- Parameter-matched **GRU** and **Transformer** models (same size, same features, same output heads)
- An ablation where I strip out the per-channel forgetting (scalar decay only)
- A no-convolution ablation
- **LightGBM** gradient-boosted trees
- Simple seasonal-naive baselines

I score all of them using proper probabilistic metrics (Weighted Interval Score, calibration, and coverage), and I also run learning curves with only 25%, 50%, and 75% of the training history. If a plain GRU or LightGBM beats the delta memory, then the simpler model wins.

*(There is also an optional forecast API endpoint wired into the capture backend that can run a trained EpiKD or tree model on uploaded monthly history, though it's disabled by default and doesn't use trap counts.)*

### 3. The Game

- [MainGame/](MainGame/) - The playable browser game, local dev server, deployment build, and Cloudflare Worker leaderboard.
- The game bundles its own trained model weights and historical demo inputs right inside the HTML, so it works out of the box without needing the private research CSVs.

---

## Research files & privacy

The raw `data/` and `outputs_epikd_*/` folders are ignored by Git. Real research datasets, trained checkpoints, field trap photos, local SQLite databases, and API keys stay outside this public repo. (The QR trap images you see in the repo are synthetic test fixtures, not real field photos.)

Note that `MainGame` still embeds historical district numbers for its playable campaign. Also, keep an eye on the cloud config files if you deploy your own copy, since they currently reference my project's resource names and public URLs.

## Running the tests

To test the capture backend:
```bash
cd VectorDock/capture/backend
python -m venv .venv
# activate your venv, install requirements.txt, then:
python -m pytest tests -q
```
*(Tests that need the private research dataset or optional ML packages will automatically skip if they aren't installed.)*

To test the game:
```bash
cd MainGame
python -m unittest discover -s tests -v
```
*(The automated browser tests need Node.js 22.5+ and Playwright with Chromium installed.)*
