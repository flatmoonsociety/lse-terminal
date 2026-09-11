# LSE Terminal

The IDE for systematic trading. Windows and Mac.
Download: https://londonstrategicedge.com/terminal

You write the strategy in Python. The terminal backtests it on the full
history, fits the models, and routes the orders. The model you talk to sees
the same screen you do and works the same engine: it reads the chart, runs
the backtest, edits the file, runs it again. The engine is a local Python
process and nothing you write leaves your machine.

**Workspace.** A Python editor where your strategy lives. `strategy.py` is
the file the backtester and the live runner both use. Lookbacks are written
in days and the engine converts them to bars for whatever timeframe the
dataset has, so the same file works on hourly and daily data.

**Backtester.** Runs the strategy over the whole dataset. There is no bar
limit on local files. You can set a date range, run walk-forward folds or
Monte Carlo resamples, and add commission and slippage. You get the trade
list, the equity curve, drawdown, Sharpe, Sortino, VaR and time in market.

**Assistant.** A model with access to the engine. It can pull candles and
economic series, run backtests, build ML datasets and train models, read
your positions and fills, open research papers, run Python and edit files in
the workspace. It also sees the chart you have open. By default it uses the
model we host, through your key. If you have Claude, Codex, Gemini, Kimi,
Qwen, Copilot or OpenCode installed, the app connects them to the same tools
over MCP and you use your own subscription.

**Models.** GARCH(1,1), Kalman filter, hidden Markov regimes, LSTM forecasts
and an autoencoder for anomaly detection. They fit on the dataset in view
and plot next to the chart.

**Data.** Over 500 TB. Tick and candle history across stocks, FX, crypto,
ETFs, commodities, futures, indices, rates and volatility; options chains
and options flow; economic series and release calendars; the US Treasury
curve; papers from NBER, BIS, the Fed and the ECB. Other sources come in
through the same adapter layer: a connected broker's prices can be charted
and traded, and a strategy can attach any series as alternative data with
`use NAME`, from economic releases to your own imports.

**Execution.** Orders go through
[Brue Connect](https://github.com/londonstrategicedge/brue-connect). Each
broker has an adapter and your broker login never leaves your computer. The
LSE demo account is the first adapter. Positions, fills and P&L show in the
ticket and the assistant can read them.

**Brue.** You can also write indicators and entry rules in
[Brue](https://github.com/londonstrategicedge/brue), a small language that
runs on a Python engine.

## Key

One free key from https://londonstrategicedge.com/data. It unlocks the data
feed and the demo account. It is saved in
`~/.config/lse-terminal/config.json` and only ever sent to
api.londonstrategicedge.com. Sign out deletes it and disconnects the demo
account.

## Install

Get the installer from https://londonstrategicedge.com/terminal. The app
checks for updates when it starts and every four hours, downloads them in
the background and installs them the next time it opens.

## From source

You need Python 3.10 or newer and Node 20 or newer (Node 22.12 or newer is
required for the Electron desktop dependencies).

```
git clone https://github.com/londonstrategicedge/lse-terminal.git
git clone https://github.com/londonstrategicedge/brue.git
git clone https://github.com/londonstrategicedge/brue-connect.git
cd lse-terminal
python -m venv .venv
.venv/bin/pip install -e ../brue -e ../brue-connect -e .
.venv/bin/lset
```

`lset` starts the engine and opens the terminal in a browser tab. The
installers are built with `desktop/build-mac.sh` and
`desktop/build-win.ps1`. Tests: `.venv/bin/python -m pytest tests/`

### Windows development

Clone `brue` and `brue-connect` beside this checkout, then run the setup from
PowerShell:

```powershell
Set-Location E:\Code\lse-terminal
.\tools\dev.ps1
```

This creates `.venv`, installs the three repositories in editable mode, builds
the React chart into the Python static directory, and starts the local engine
at `http://127.0.0.1:7787`. Development data is kept under `.dev-data`, so the
installed application's account, workspace, and chats are not used. Add
`-Desktop` to open the source Electron shell with the same isolated profile.

Backend checks:

```powershell
.\.venv\Scripts\python.exe -m pytest tests
node --test desktop\main.test.js
```

## Files

`~/.config/lse-terminal/` has the key, imported data, workspace, indicators,
notebooks and assistant chats.

## Licence

MIT.
