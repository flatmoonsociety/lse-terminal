# TERMINAL WALKTHROUGH

Everything the terminal does, tab by tab, and how each part works. This is the same text the assistant reads when you ask it how the terminal works, so what it tells you and what you read here come from one document.

| Tab | What you do there | Needs the LSE key |
|---|---|---|
| MARKETS | Live charts with indicators and drawings, the option board, the news wall, the screener, the trade ticket and account dock | Yes |
| BACKTEST | Write strategies in Python and run them on your own data, train machine learning models, replay bars and trade by hand | No |
| ECONOMIC | Release calendar with surprises, national statistics by country, bond yield curves, central bank board | Yes (NEWS: no) |
| WORKSPACE | The IDE with a real terminal, a chart builder for any table, notebooks on an infinite canvas | No |
| RESEARCH | New quant papers with an in app reader, interactive quant models fitted to your data | No |
| MY DATA | Import files, download databank history, manage the library, the ten samples | Only for the databank |
| TERMINAL WALKTHROUGH | This document: colour coded by area, searchable, cross linked, glossary at the end | No |

Search the walkthrough from the box above the contents; the glossary at the end defines every term the interface uses. Sections are colour coded by area (the dots above, the numbered badges, the left edge of each card); words in blue link to the section or glossary entry that explains them: hover for a preview, click to go there.

## What the terminal is

LSE Terminal is a free desktop application for market research and strategy testing. It runs on your own computer: charts, backtests, machine learning, notebooks and the assistant all execute locally, and your data stays on your disk.

Three things sit behind the app:

- **The engine.** A local Python server that starts with the app. It serves the interface, reads your imported files, runs your strategies, trains models and talks to data sources on your behalf. Every page in the terminal is a view over this engine.
- **LSE data.** Optional live and historical market data from London Strategic Edge, unlocked by one free API key. Without a key the terminal still runs (imports, backtests, notebooks, research all work); with a key the MARKETS, ECONOMIC and OPTIONS pages fill with live data and the databank opens for downloads.
- **The assistant.** A permanent right hand panel where you can talk to Veron, or sign in to your own AI coding agent (Claude or ChatGPT) and let it work on your strategies with the terminal's tools.

The terminal is backtesting first. Charts exist to show markets and results; the centre of the product is writing a strategy in plain Python, running it on your own data, and reading honest numbers back.

## Getting started

Download the app, open it, and it works with the ten sample datasets that ship inside; the free LSE key adds live data and is entered once under MARKETS.

1. **Open the app.** The engine starts in the background and the window shows MARKETS. The desktop app runs the engine on port 7799 (or the next free port); a source checkout run with `lset` uses 7787 and opens your browser. Either way the interface is `http://127.0.0.1:<port>/`.
2. **Get a free LSE API key** at londonstrategicedge.com/data and paste it into the MARKETS connect form (or the connection control top left). The key is proved against the live instrument list before it is accepted, then stored in your local config file with owner only permissions. It never appears in the page.
3. **Look at MY DATA.** Ten sample datasets are already there in a Samples folder: GOLD, EURUSD, SPX500 and BTCUSD as hourly candles; SILVER, BRENT, USDJPY, NAS100 and AAPL as daily candles; USYIELDS, a daily US Treasury curve, as an alternative series. Every backtest and model in the app can run on these with no key and no import.
4. **Open BACKTEST.** Seven starter strategies are seeded into your workspace on first open. Pick one, click a dataset in the library on the left, press RUN, and the report prints in the terminal dock underneath.
5. **Ask the assistant.** The right hand rail talks to Veron with the same key. Ask it to write a strategy over your data; it tests the code on your machine before it hands it over.

## The layout

The header holds the connection control, the five rail tabs, then TERMINAL WALKTHROUGH and MY DATA on the right, the update button and the theme toggle; a secondary bar under the rail lists the active tab's sub views; the left column is the watchlist or the file library; the right rail is the assistant.

- **Connection control (top left).** Shows the active data connection ("Live data" or "No data key") and the connected broker. Click it to open the Connections screen (see Connections and keys).
- **Rail tabs.** MARKETS, BACKTEST, ECONOMIC, WORKSPACE, RESEARCH. Each tab is a page; the secondary bar under the rail carries its sub views (for example MARKETS has PRICE & CHARTS, OPTIONS, NEWS, SCREENER).
- **TERMINAL WALKTHROUGH and MY DATA (top right).** This document, and your imported files and library, each one click away from every page.
- **UPDATE.** Hidden until a newer release exists. It then shows the version, downloads it, and offers a restart to install. Source runs check hourly and show a banner instead.
- **Theme toggle.** Light or dark. The choice is remembered and the page reloads so every chart and panel repaints in the new theme.
- **Left column.** On MARKETS it is the watchlist (live instruments in folders). On BACKTEST, MY DATA and WORKSPACE it is the library tree: your strategy files, your imported datasets and your notebooks in one list. ECONOMIC, RESEARCH and the walkthrough hide it. A chevron on the divider folds it to a slim strip.
- **Right rail.** The assistant, plus the trade ticket at the top when you are on MARKETS > PRICE & CHARTS with a live key. Drag its left edge to resize; the double chevron folds it.
- **Window title.** Follows the charted instrument and timeframe on MARKETS, and names the page elsewhere.

## MARKETS

MARKETS is live data: charts with indicators and drawings, an options board, a news wall, a screener across the whole instrument universe, and the trade ticket with its account dock. It needs the free LSE key; without one the tab shows the connect form, and OPTIONS, NEWS and SCREENER stay reachable from the secondary bar.

### Price & charts

- **Symbol search and watchlist.** The box in the toolbar searches the whole LSE instrument list with suggestions as you type. The watchlist on the left lists every instrument in collapsible category folders with a logo, name, last price and spread; big folders load 200 rows at a time as you scroll. Clicking a row charts it and points the trade ticket at it. The star on a row (visible on hover) pins the instrument into a WATCHLIST group at the top of the sidebar, one list per data source, remembered with your workspace.
- **Timeframes.** From tick and 1 second up to 1 week on LSE data (tick, 1s, 30s, 1m, 5m, 15m, 30m, 1h, 4h, 1d, 1w). Imported files can only be viewed at their native resolution or coarser; finer buttons render disabled with the reason in the tooltip.
- **Chart types.** Candles, Bars, Line, Area. (In this build Bars draws as candles.)
- **Indicators.** The Indicators button opens a searchable list of every registered indicator, about 115 shipped ones plus anything you write yourself. Click a row to add or remove it, star it to keep it at the top, and open the pencil on an active row to edit its parameters. Active indicators show as chips above the chart. Indicator maths runs in Python inside the engine and comes back with the candles, so the chart and any script you write see the same values.
- **Custom indicators.** "+ Create custom indicator (Python)" opens the indicator editor: one Python file, `from lse_terminal import indicator`, one decorated function over the candle DataFrame. The draft previews live on the charted symbol while you type, overlay output draws on price, pane output draws below. The editor has examples (EMA cross, RSI, ATR bands), a Docs column with the full parameter and styles reference, and an Ask AI button that hands the code and the last error to the assistant. See Custom indicators.
- **Drawings.** The tool rail on the left of the chart carries 33 tools: trend lines and rays, parallel channel, arrows, horizontal and vertical lines, Fibonacci retracement and extension, sixteen shapes, brush, highlighter, freehand arrow, text, long and short position tools, and a measure tool. Drawings and indicator setups are stored per instrument and come back when you return to it. Escape cancels a drawing in progress; Escape or Backspace deletes the selected one. Star a tool to favourite it; lock, hide, delete selected and clear all sit in the same rail.
- **Screen layout.** The layout button offers grid presets from a single chart up to eight panes (2 and 3 horizontal or vertical, 2x2, 3x2, 2x3, 4x2) with sync toggles for symbol, interval, crosshair and time. With symbol sync off, a watchlist or search pick retargets only the selected pane.
- **Templates.** Save the current chart setup under a name (symbol, timeframe, chart type, active indicators with their parameters, and the appearance settings) and apply it later from the toolbar Templates menu or the chart's right click menu.
- **Chart layout panel.** Colours for candles, wicks, background, grid, crosshair, axis labels and the price tag; the chart's timezone (UTC, local, or ten named zones) and zoom speed. Edits repaint live and persist.
- **Right click on the chart.** Chart template submenu, Reset chart view, Flip chart, Remove drawings, Settings.
- **Live lines.** Bid and ask lines when a real quote exists, a bar close countdown on the price tag (blank when the market is closed), and your open positions on the charted symbol drawn as order lines you can select, drag the stop and target on, or close from the line.
- **Level 3 data.** A toolbar button that appears only when your key's plan carries order by order futures data and the charted instrument maps to a recorded contract. It opens a rail with an order stacking ladder and the order flow over a short delayed window. For most keys the button never exists.

### Options

The OPTIONS sub view is a full page option board over LSE data. The left rail lists every optionable underlying (most active first, ALL pinned on top) with a filter box. Two views: **Chain** shows calls and puts around the strike spine (Last, Vol, Prem, IV and Delta per side; Vega, Theta and Gamma with the Greeks toggle) for a chosen expiry, with a strikes shown control (Auto, 16, 30, 60, All) and a 15 second auto refresh; **Flow** is the stream of prints filtered by contract type and minimum premium ($10k to $1M), with new prints flashing and the large ones set heavier. The analytics column beside the chain carries put/call volume and premium, total premium, ATM IV, an IV smile, the ATM IV term structure, volume by strike, and the payoff at expiry of any contract you click. Without a key the page explains what it needs instead of erroring.

### News

The NEWS sub view is a headline wall behind an animated globe. Drag the globe to rotate, wheel or pinch to zoom, hover a pin to read its headline, click to focus, double click open ocean to reset. The right column has two blocks: LSE NEWSROOM, original articles that open in an in page reader, and HEADLINES, the wire. Both come from files shipped with the app, so the page works offline and needs no key. The same page is reachable from ECONOMIC > NEWS.

### Screener

The SCREENER sub view is the whole live universe as one sortable table, 100 rows per page with a running count. Asset class chips filter the rows; view buttons swap the columns: OVERVIEW (price, returns, volume, market cap, RSI, distance from the 52 week high, next event), PERFORMANCE (returns from 1 hour to 1 year, gap, move percentile), TECHNICALS (RSI, ATR, realised vol, Bollinger position, distance to the 20, 50 and 200 day averages, correlations and beta), FUNDAMENTALS (market cap, sector, P/E, dividend yield, margins, revenue and growth, earnings timing and surprise), OPTIONS (option volume, put/call, net premium, ATM IV, IV rank, skew, biggest print, max pain), POSITIONING (COT net positioning and change, insider buys and sells, news count) and EVENTS (next event, its impact, event risk score, macro surprise, average event move, days to earnings). Click a column header to sort (nulls last), type in the filter box to narrow by symbol or name, and click a row for the profile card: logo, description, sector, exchange, country, key stats and an Open chart button that jumps to PRICE & CHARTS. Refreshes every 30 seconds while open.

### Trading: the ticket and the account dock

- **Trade ticket.** Sits at the top of the right rail on PRICE & CHARTS with a live key. It follows the charted instrument (logo, symbol, name), shows the account line (click it to change account in Connections), SELL at bid and BUY at ask with the spread between them, a size field in the venue's own unit (lots, shares or units), optional stop loss and take profit, and a margin block (one lot value, order value, tick value, margin, free margin after, used) computed from the venue's own terms. Open positions list inline with a one click close. A sash between ticket and assistant divides the rail; drag it, double click to reset.
- **Account dock.** The strip under the chart: Balance, Equity, Open P&L, Used and Free margin, Leverage in the account's currency, with Positions and History tabs. Left or right click a position row for Show on chart, Close 25%, Close half, Close 75%, Close position. The dock's top edge drags to resize and a minimiser folds it to the summary strip.
- **Where orders go.** With no broker connected, orders route to the LSE demo account (a paper broker with the same contract as a real one). Connect a broker in the Connections screen and the same ticket and dock drive that broker instead. See Connections and keys.

## BACKTEST

BACKTEST is where strategies are written and tested on your own data. Three modes in the secondary bar: ALGO DEVELOPMENT (a code editor with one click backtests), MACHINE LEARNING (train models on your imports, on this machine), and MANUAL (bar replay you trade by hand). Entering the tab switches the data source to your library; nothing here touches live data.

### Algo Development

The IDE, with the assistant set up for strategy building: on this page a **Strategy brief** panel sits at the top of the right rail, above the assistant. Pick the dataset to trade, the approach (trend, mean reversion, breakout, momentum, regime filter, pairs, machine learning, or the assistant's pick), long only or long and short, the holding horizon, the risk rules (ATR stop, take profit, volatility targeted sizing), costs, the validation you want (walk forward, Monte Carlo) and a free line, then press **Build it**: one precise request goes to the assistant, which writes the strategy, tests it on your machine, runs the validation and reports honest numbers, and the code arrives with a To strategy IDE button. **Improve open file** applies the same brief to the strategy in the editor. Your choices are remembered; the panel folds to one line. The library on the left is the explorer: your strategy files under WORKSPACE, your datasets under DATA, your notebooks under NOTEBOOKS. The editor is a syntax highlighted Python editor with tabs, a line gutter, and autosave 800 ms after you stop typing. Underneath is the terminal dock: an output console for runs, plus as many real shells and Python REPLs as you open (the + button; the chevron picks Shell or Python; the bin closes one). The chip beside RUN says which dataset a run will use.

**Running.** Click a dataset in the library to select it (its preview opens as a tab: columns and a 100 row sample with a Load more button). Press RUN. If the file looks like a strategy (it builds a `trades` list) it runs as a backtest on the selected dataset at that file's native timeframe, up to 100,000 bars; anything else runs as a plain Python script with its output streamed into the console and a STOP button.

**The report** prints into the console: every trade as a line (side, entry time and price, exit time and price, P&L and P&L %), a one line equity sparkline, then the statistics: net profit, final equity, trades with the win and loss split, win rate, profit factor, max drawdown (absolute and %), Sharpe, average trade, average win and loss, largest win and loss, longest winning and losing streaks, plus the extended block (VaR 95 and 99, CVaR, Sortino, Calmar, annualised return and volatility, exposure, average bars held). A green or red chip with the last result appears next to the file in the library. Anything the strategy puts in a `plots` dict draws as small chart panes above the console.

**Walk forward and Monte Carlo** run over the same engine and are reached through the assistant (its `run_walkforward` and `run_montecarlo` tools) or the engine's HTTP API. Walk forward sweeps a parameter grid on each training window and measures the untouched window after it, reporting per fold best parameters, in sample and out of sample profit and an efficiency ratio. Monte Carlo resamples the closed trade P&L a thousand times (seeded, so it is reproducible) for drawdown percentiles and risk of ruin. Neither has a button in the IDE in this build.

### The strategy contract

A strategy is a plain Python file. There is nothing to import from the terminal and no base class.

- `df` is already in scope: the selected candles as a pandas DataFrame with `ts`, `open`, `high`, `low`, `close`, `volume` (`ts` is epoch seconds).
- `params` is a dict of overrides, empty on a normal run. Read your tunables out of it, `fast = params.get("fast", 9)`, so walk forward can sweep them without editing the file.
- `data` is a lazy dict of every dataset in your library, keyed by exact symbol: `data["USYIELDS"]` or `data["NAS100"]` load on first read and cost nothing if unused. Join across datasets on `ts`, never by row position.
- Leave a list called `trades`, one dict per trade: `trades.append({"entry_i": 10, "exit_i": 25, "dir": "long"})`. Bar indexes or `entry_ts`/`exit_ts` in epoch seconds both work; `dir` defaults to long; prices default to those bars' opens (`entry`/`exit` override them); size defaults to the whole account, compounding (`qty` sets an absolute size).
- Optionally leave `plots`, a dict of name to per bar series, to draw panes above the console.
- The engine does sizing, commission, the equity curve and every statistic. Never hand roll those.
- A run is killed after 120 seconds by default.

Two comment lines at the top of a file pin it:

- `# run: EURUSD 1h` names the dataset (and optionally the timeframe) this strategy is meant to trade. RUN, the assistant's tools and the workspace runner all target the pinned dataset when no explicit one is given, so the same file reproduces the same numbers wherever it runs. Clicking a different dataset while a pinned file is open rewrites the pin visibly. A pin naming a dataset that is not in your library is a hard error, never a silent fallback.
- `# name: usdjpy_sma_trend` names the file when a chat code block is sent to the IDE.

Example:

```python
# run: EURUSD 1h
# name: ema_cross
import numpy as np
import pandas as pd

fast = params.get("fast", 9)
slow = params.get("slow", 21)
f = df.close.ewm(span=fast).mean()
s = df.close.ewm(span=slow).mean()
up = (f > s) & (f.shift() <= s.shift())
down = (f < s) & (f.shift() >= s.shift())

trades = []
entry = None
for i in range(len(df)):
    if entry is None and up.iloc[i]:
        entry = i
    elif entry is not None and down.iloc[i]:
        trades.append({"entry_i": entry, "exit_i": i, "dir": "long"})
        entry = None
```

Seven starter strategies are seeded into `workspace/strategies/` on first open (volatility targeted trend, Ornstein Uhlenbeck half life reversion, variance ratio gated trend, a yield curve regime overlay that reads the USYIELDS series through `data`, multi horizon time series momentum, Kalman slope trend, and a signal ensemble with an equity kill switch). They follow the house rules: decide on bar i, fill at bar i+1 open; causal rolling statistics only; parameters in `params` with defaults; horizons stated in days and converted from the dataset's own bar spacing.

### Machine Learning

Train models on your imported data with this computer's own CPU or GPU. The left column is a catalog of 21 models in six groups: FORECASTING (LSTM, ARIMA/SARIMA, Transformer, Prophet), CLASSIFICATION (XGBoost, Random Forest, LightGBM, CatBoost, MLP), RISK ANALYSIS (GARCH, Monte Carlo, Value at Risk, Copula, Regime Switching HMM, PCA factor analysis in 3D), DEEP LEARNING (CNN pattern recognition, Autoencoder anomaly detection, GAN price simulation), TIME SERIES (Wavelet decomposition, Kalman filter) and SENTIMENT (NLP). Each card carries a GPU tag when the model uses a GPU and a SETUP tag while its libraries are not yet installed. Selecting a SETUP model shows a banner that names the missing library, says whether it is on this computer yet and which other models use it, with an Install button; the download and install progress prints in plain words (what is downloading, how many MB), and the tag disappears when it finishes. The **Libraries** badge in the page header (installed count out of nine) opens the Libraries panel: every optional library on one row with its installed version, what was downloaded (size and date) when the terminal installed it, the models it unlocks, an Install button per row and Install all missing; the footer names the folder the installs live in (kept across app updates).

Every run is a small Python blueprint in the editor:

```python
from lse_terminal.ml import blueprint
run = blueprint.train(model="lstm_forecast", dataset="EURUSD",
                      timeframe="1h", bars=5000,
                      features=["close", "volume", "rsi_14"],
                      params={"epochs": 50, "sequence_length": 60})
blueprint.report(run)
```

Clicking a model writes its blueprint with the full parameter schema; the dataset dropdown rewrites the `dataset=` line in place so code and dropdown never disagree. **+ Build dataset** resamples an import to a timeframe and window (200 to 500,000 bars) and bakes in any of 69 features (volume, momentum, trend, volatility, statistical and economic families) as columns, saved to the ML dataset store. RUN streams the training log live; two trainings can run at once; STOP cancels. Results render as stat tiles from whatever the script reports (a PCA run gets an interactive 3D view with a scree chart), and RECENT RUNS lists the last twelve jobs to reopen. The header badge states the compute in use: GPU with the device name and memory, Apple Silicon, or CPU.

### Manual

Bar replay you trade by hand. The setup dialog asks for the pair, the timeframe (1 minute to 1 day; finer than the file's native resolution is disabled), the timezone, a start date and time (with quick ranges from last month to last year), optional starting capital (default 10,000) and an optional spread in pips (buys fill at ask, sells at bid). The chart then replays from that date one bar at a time: play and pause, speed (1x, 10x, 100x), step back and forward five bars, switch timeframe without losing your place, an Indicators button and a Layout popover for multi chart grids with crosshair sync. Trade with market buy and sell, buy and sell limits and stops placed on the chart, a lot size selector, and stop loss and take profit lines you drag on the chart (right click removes). Playback pauses while you place an order. Positions and pending orders list with live P&L. Trade History opens the full log; End opens the session report: win rate, profit factor, expectancy, max drawdown, Sharpe, streaks, trade duration, long versus short, sessions, an overall grade, and Export to CSV. Save stores the session (trades, pending orders, capital, position in the replay) on this machine.

## MY DATA

MY DATA is your library: files you import, files you download from the LSE databank, and the ten samples. Everything under BACKTEST, the WORKSPACE tools and the RESEARCH model fits read from here.

- **Import.** Click the drop zone or drop a file anywhere in the app: CSV, TSV, TXT, Parquet, Feather, Excel, JSON (up to 200 MB). Column names are matched loosely (ts, time, date; o/h/l/c or full words; epoch seconds or milliseconds or date strings). A file with open, high, low, close becomes **candles**, chartable and backtestable, with the timeframe inferred; any other timestamped numeric table becomes a **series**, an alternative dataset your strategies read through `data[...]`.
- **On disk.** Each import is stored as a normalised CSV (ts in epoch seconds) under `~/.config/lse-terminal/data/`, with a `manifest.json` beside them recording name, kind, rows, timeframe, folder, columns and date span. The page prints the exact path with an "open folder" link.
- **The library tree.** Shared by every page: WORKSPACE (your .py files) above DATA (imports) with folders you create, rename or delete (contents move up), drag and drop between folders, rename and delete on each row, and a tooltip with columns, rows, span and import date. Clicking a dataset from MY DATA takes it to Algo Development as the selected dataset with its preview open; in WORKSPACE the same click copies a `pd.read_csv` snippet instead.
- **Import from LSE.** The "Import via LSE Data" button on the library toolbar opens the databank: the full recorded history behind the platform, unlocked by your key. Pick a dataset class (markets, options, series, reference), search the catalog (each instrument with its logo, name and years of coverage), choose a timeframe chip (tick and every candle interval), a range chip (Max, 1y, 180d, 90d, 30d, 7d, or custom dates bounded to the instrument's real coverage) and a library folder (default LSE), then Download to library. Candles and series import straight into the library; raw ticks, options and reference tables are saved as Parquet files on disk instead. A quota line shows what your key allows.
- **Samples.** GOLD, EURUSD, SPX500, BTCUSD (1h), SILVER, BRENT, USDJPY, NAS100, AAPL (1d) and USYIELDS (a daily Treasury curve series) are seeded on first launch into a Samples folder. If you delete one, the RESEARCH model fit bar can add it back.
- **Preview.** Any dataset opens as a tab with its columns and a 100 row sample; Load more reveals up to 5,000 rows.

## ECONOMIC

ECONOMIC is the macro side: a release calendar with consensus and surprises, national statistics for every country the databank carries, government bond curves, and a central bank board. It needs the LSE key (NEWS does not).

- **CALENDAR.** Releases grouped by day: time, region, impact dot, event, Actual, Consensus, Previous (revised values marked). Filter by date range (Today, This Week, Next Week, Next Month, Past Month, Custom), by region (multi select with a Majors shortcut), by impact (All, High, Med, Low) and by text. Click a row for the detail pane: latest actual, consensus, the surprise (beat or miss), the next release and its expected value, and a history chart (bars, line or area; 1Y to All; consensus and previous overlays; beat and miss colouring). Speeches and auctions list but do not chart.
- **NEWS.** The same globe and headline wall as MARKETS > NEWS.
- **INDICATORS.** Every national statistic in the vault, by country and category: a country picker (sorted by depth of coverage), a category dropdown, and a table of series with source, latest value, one year change, frequency and observation count. Click a series for the pane: latest, change, range, and a line chart with 1Y, 5Y, 10Y and All ranges (percent series draw stepped).
- **BOND YIELDS.** Government curves back to 1990. Curve mode plots a country's whole curve today against one month and one year ago (with real yields where linked bonds exist) and tables each tenor with a one year sparkline, yield and 1D, 1M, 1Y changes in basis points. Cross country mode takes one tenor across every country. Click any row for that series' daily history.
- **CENTRAL BANKS.** One row per bank: policy rate, inflation, balance sheet, money supply and reserves, majors on top, with search. Click a row for the policy rate history, the next scheduled decision and the last six decisions, and the bank's other statistics.

## WORKSPACE

WORKSPACE is the full session: the IDE with an explorer, editor tabs and a real terminal; a data visualisation builder for any table; and a notebook canvas. Entering it unfolds the assistant rail, since the point of the tab is code, data and the assistant side by side.

- **IDE.** The explorer is the same library tree (WORKSPACE files, DATA, NOTEBOOKS) with Import via LSE Data, Upload, Folder and Script buttons and the on disk path underneath (click to open the folder). Files open in tabs with dirty markers and autosave. New files are created inline (VS Code style), default to `.py`, and never overwrite. RUN runs the open file: a strategy as a backtest on the pinned dataset, anything else as a script. The terminal under the editor is a real PTY in your workspace folder: Shell (your system shell) or Python (the engine's own REPL, with the terminal's packages), with a restart button and a draggable sash. Files live at `~/.config/lse-terminal/workspace/`; allowed types are .py, .md, .txt, .json, .csv and .svg.
- **DATA VISUALISATION.** Bring a table three ways: open a file (csv, tsv, txt, parquet, feather, xlsx, xls, json, ndjson; parsed in memory, nothing written), paste rows, or pick a library dataset. Then choose from twenty chart forms grouped Compare, Trend, Financial, Distribution, Relationship, Part of whole, Single value and 3D (bar, horizontal bar, grouped bar, line, area, candlestick, scatter, bubble, pie, donut, histogram, box plot, heatmap, radar, treemap, funnel, gauge, 3D bars, 3D scatter, 3D surface). Suggested forms for the loaded table are marked; hovering a tile previews it, clicking commits. The encoding bar assigns columns to X, Y or series (up to eight), size and colour; a palette picker persists; export as SVG or PNG (3D forms are PNG only: drag to rotate, wheel to zoom, double click to reset). A Columns card lists every field with its inferred type and a table view of the first 500 rows. Library rows with enough data show a MODEL button that jumps to RESEARCH > QUANT MODELS with the diffusion simulator fitted to that dataset.
- **NOTEBOOK.** An infinite canvas per notebook. Blocks: text, sticky note, code, maths (KaTeX), image, ink (pen and highlighter), shapes (line, arrow, rectangle, ellipse, triangle, diamond, star). Toolbar keys: V select, H hand, T text, N sticky, C code, M maths, P pen, G highlighter, E rubber, L A R O Y D S for the shapes, I image; a maths symbol palette with saved equations and handwriting recognition of drawn symbols into LaTeX; Paper sets the background colour and ruling (dots, grid, lines, plain); undo and redo (Ctrl+Z, Ctrl+Shift+Z); Fit everything (Ctrl+0). Images arrive by paste, drop or the picker. Each notebook is one JSON file under `~/.config/lse-terminal/notebooks/`, autosaved; images sit in its assets folder.

## RESEARCH

RESEARCH is the reading tab: a live wire of new quantitative finance papers with an in app reader, and interactive visualisations of the standard quant models that you can fit to your own data. Articles need no key.

- **ARTICLES.** The newest papers from arXiv q-fin plus NBER, BIS, Federal Reserve and ECB working papers, refreshed server side (a shipped snapshot serves the page offline). The left column filters by LATEST, by source and by category (Options & Volatility, Portfolio & Factors, Microstructure & Trading, Risk, Machine Learning, Macro & Banking, Digital Assets, Methods & Computation); the search box matches title, abstract, authors, source and category. Each card carries the source, date, category, title, authors, abstract and a thumbnail of the paper's first page. Clicking a title in the desktop app opens the PDF inside the terminal (fetched by your machine, shown same origin), with Open in browser and an **Ask AI** button that hands the paper to the assistant with an instruction to read the full text first. Escape closes the reader.
- **QUANT MODELS.** Twenty interactive models with live parameters, grouped OPTIONS & VOLATILITY (implied vol surface, Black-Scholes, Greeks, Heston, GARCH(1,1)), SIMULATION & RISK (Monte Carlo GBM, diffusion simulator, Value at Risk, efficient frontier, correlation matrix, PCA factor structure, Nelson-Siegel term structure), FILTERS & STATE (Kalman filter, hidden Markov model, Gaussian process) and MACHINE LEARNING (neural network, XGBoost, LSTM, temporal ConvNet, transformer attention). Each shows its formula above the visualisation. The **FIT TO MY DATA** bar picks a library dataset (30 rows or more), a column when there are several, or several datasets for portfolio models; the options models can fit a live LSE option chain by underlying when a key is set. Toggle between the parametric view and your data, and read the provenance list (columns, sample, estimator, caveats) under the fitted chart. Fits run on your machine.

## The assistant

The right rail is one panel with two kinds of AI behind it: **Veron**, hosted by LSE, which needs only your free key, and your **own AI coding agent** (Claude or ChatGPT), which you install and sign in to yourself and which then works inside the terminal with the terminal's tools. Both read this walkthrough, so either can explain how the app works.

### Veron

- **What it is.** A chat assistant served by London Strategic Edge, reached through your local engine with your LSE key (the key stays on your machine; the engine attaches it). Free to use with the key; the daily message allowance follows your key's plan. The **i** beside the provider picker opens a card with the allowance, what you have used today and what a message sends; `/usage` posts the same as a note.
- **What it sees each turn.** The page you are on, the charted symbol and timeframe, the strategy file open in the editor and its contents, the paper open in the research reader, the last lines of the visible terminal (so "look at the error" works), and a screen map of every panel with its live values. It does not see pixels.
- **What it can do on your machine.** It has local tools that your terminal executes for it: list your datasets, preview a dataset exactly as a strategy receives it, run a backtest, put a tested run on screen (files the strategy, pins its dataset and runs it in Algo Development), read this walkthrough, and the shared read-only set your own agent also gets: positions and fills, candles, the economic calendar, walk forward and Monte Carlo, the research feed and paper text, your workspace files (read only), open a page or dataset in the app, remember and recall, and the ML catalog and jobs. The tool strip under the chat header lists them; click one for its parameters. Its rule for every strategy request is read the library, preview what it is unsure of, write the code, run it itself, fix and rerun on errors or zero trades, and only then deliver: the final code in one block with the real numbers and the dataset it ran on, and an honest warning if the best run still loses. The engine enforces this: code that was never run comes back for a test, a tested strategy described without its code gets the code attached, and code that differs from what was tested is re run and stamped with its verified numbers.
- **The walkthrough.** It carries a summary of this walkthrough on every turn and a `read_guide` tool for the full text, so questions about what the terminal does or how to do something are answered from this document.
- **From chat to the IDE.** Every code block has Copy; Python blocks add **To strategy IDE**, which files the code under `workspace/strategies/` (named from its `# name:` line), pins it to the dataset it was tested on, and points the library at that dataset.
- **Papers.** When a message names a research paper (the reader's Ask AI does this), the terminal extracts the paper's text and attaches it before asking, so answers come from the paper, not from memory of it.
- **The web.** It can search the live web and read pages and PDFs (never files, videos or archives), and cites what it used. It does not search for numbers the terminal already has.
- **While it works.** Tool calls and the model's steps show as activity lines in the transcript, so a long turn (write, test, fix, validate) never looks idle.
- **Empty state.** With no messages it shows the charted symbol and timeframe and three starts on it (an account risk check, a yield curve read for the symbol, a mean reversion build and backtest).

### Your own agent

- **Providers.** Claude (Anthropic's Claude Code CLI) and ChatGPT (OpenAI's Codex CLI). Pick one in the provider menu at the top of the rail; the row shows its status (Not installed, Sign in, the account email, Ready). Anything other than Veron runs on your own account and your own subscription; the terminal never proxies it.
- **Install and sign in.** If the CLI is missing, an Install button runs its npm install with the output streaming into the panel. Log in runs the CLI's own login: the browser link (and a paste the code field when the CLI asks) appears in a card, and success posts your signed in identity. Account & usage in the `/` menu shows the identity, connection mode (subscription, API key or Foundry), sign out, and remove connection.
- **What it is told.** On the first turn the agent receives a brief: what the app is, where your data lives, the strategy contract, the pin lines, the tools, this walkthrough, and anything you wrote in USER.md. The brief is also written to `~/.config/lse-terminal/ai-workspace/` as `LSE-TERMINAL.md`, `CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, `QWEN.md` (one text under every name the CLIs read) beside `GUIDE.md`, `context.json` (the live app state, refreshed every turn), `strategy.py` (a mirror of your open editor) and `backtest.py` (a runner the agent can call).
- **USER.md.** The one hand editable instruction file, opened from the gear in the rail. Trading style, preferred markets, risk rules, tone: everything you write there is appended to what every agent is told.
- **Its tools.** The terminal exposes its own capabilities to the agent as native tools: run_backtest, run_walkforward, run_montecarlo, get_candles, list_datasets, get_positions, get_fills, get_economics (the macro calendar for event studies), import_lse_data (pull a databank instrument into your library), list_research and read_research_paper, read_guide, list_ml_models, build_ml_dataset, generate_ml_blueprint, run_ml_blueprint, get_ml_job, open_in_app (opens a dataset, a file, or a page on your screen), list_workspace, read_workspace_file, write_workspace_file, run_python (runs a script in the workspace), web_search, fetch_url, browse, remember and recall. The tool strip under the chat header lists them; click one for its parameters. The same tools are served on `http://127.0.0.1:<port>/mcp` for any other MCP client on your machine (a Claude Code session in an editor, Claude Desktop).
- **Autonomy.** Ask (every risky action needs your Allow in the chat), Auto edit (file edits run, commands still ask), Full auto (no prompts; confirmed once). Allow, Always allow and Deny cards appear in the transcript; Always allow persists a rule.
- **Seeing your screen.** In the desktop app a screenshot of the window is taken before every turn and its path is given to the agent, with the instruction to use it for shape (what is charted, which panel is open) and never for numbers, which come from context.json or a tool.
- **Safety nets.** Every turn snapshots your workspace first; the message shows a Revert button that restores the files. Sessions resume where they left off; Previous chats reopens any conversation. `remember` stores durable facts about you (`~/.config/lse-terminal/assistant_memory.json`) that are handed to the agent at the start of every chat.
- **Modes.** Eight stances the assistant can take, for both Veron and your own agent: `/quant` (practitioner rigour: causality, costs, benchmark, sample size), `/audit` (adversarial review of the code on screen: leaks, bugs, overfitting, with a SAFE / FIX FIRST / DO NOT TRUST verdict), `/teach` (explain concept and code line by line), `/fast` (answer only), `/research` (hypothesis first: literature, mechanism, testable design), `/risk` (sizing, drawdown, ruin, correlation), `/debug` (read the error, root cause, smallest fix, verify), `/pm` (a six line portfolio manager brief: decision, size, invalidation). `/quant` alone sets the stance for every turn until `/mode off`; `/quant <text>` runs one turn in it. The composer names the active mode, user bubbles carry a small mode tag, and the mode persists with the chat.
- **Chat chrome.** The `/` menu holds Attach file, Mention a dataset, Clear conversation, Mode, Switch model, Effort (Claude), Account & usage, Usage today, Switch account, Open the agent's terminal, Help. Paste an image into the composer and the agent receives it. Stop aborts a turn.

### Ask AI buttons

The indicator editor and the research reader carry Ask AI buttons that unfold the rail and prefill the composer with the code (and its last error) or the paper; WORKSPACE unfolds the rail on entry.

## Connections and keys

The connection control top left opens the Connections screen: your LSE data key first, then the brokers. Broker credentials never leave your machine.

- **DATA CONNECTION.** The London Strategic Edge card: key set or not, Add key or Change key with an inline field, proved against the live API before it is trusted. One key unlocks MARKETS, OPTIONS, SCREENER, ECONOMIC, the databank, and Veron.
- **BROKERS.** For now the list offers the LSE demo account (`lse-sim`), a paper broker that speaks the same contract a real broker will, and one line announcing that other venues are upcoming. When a venue is listed, its row expands to a credential form generated from the broker's own handshake (what you type is stored by the engine in that broker's private state folder and rides no protocol message) or to a browser login the engine opens and waits on (up to five minutes; a chooser appears if the broker offers several accounts); a live money broker requires an explicit confirmation and orders are refused until a successful connect has armed it; disconnecting returns the ticket to the demo account; a connected broker that serves candles can also be chosen as the chart's data source.
- **Inquire.** The one coloured control on the screen (bottom right) opens the broker inquiry form (firm, website, contact, work email, asset classes, regulator, message) for firms that want to be listed. It posts to London Strategic Edge, not to your engine.

## Custom indicators

Indicators are one Python file each and register themselves with a decorator; the terminal computes them in the engine and draws them on the chart like any built in.

```python
from lse_terminal import indicator

@indicator("my_ind", title="My Ind", overlay=True,
           params={"length": {"type": "int", "default": 20, "min": 1, "max": 500}})
def my_ind(df, length=20):
    return df["close"].rolling(length).mean()
```

- The function receives the candle DataFrame (`ts`, `open`, `high`, `low`, `close`, `volume`) and each parameter as a keyword argument.
- `params` is a dict keyed by parameter name; each value is a dict with `type` (int, float, bool, str) and optional `default`, `min`, `max`. The parameter editor is generated from it.
- Return a Series for one line, or a DataFrame for one line per named column, the same length as `df`. `overlay=True` draws on the price chart, `False` in its own pane. Per column render hints go in `styles`, for example `styles={"hist": {"kind": "histogram"}}`.
- Save from the editor and the indicator appears in the Indicators list under Your indicators; the draft previews live on the charted symbol while you type. Files live in `~/.config/lse-terminal/indicators/` and load with the engine. `.brue` indicator scripts sit in the same folder (older-format files still load).

## Where things live on this computer

Everything the terminal writes sits under one folder, `~/.config/lse-terminal/` (on Windows that is `C:\Users\<you>\.config\lse-terminal\`), and can be moved with the `LSE_TERMINAL_CONFIG_DIR` environment variable.

| Path | What it holds |
|---|---|
| `config.json` | Your LSE key and settings, owner only permissions |
| `data/` | Imported datasets as normalised CSV, plus `manifest.json` |
| `workspace/` | Your strategy files and scripts (the WORKSPACE and BACKTEST explorer) |
| `notebooks/` | One JSON per notebook, images in `assets/` |
| `indicators/` | Your custom indicators (.py and .brue; older-format files still load) |
| `ml/datasets/` | Datasets built for machine learning |
| `ai-workspace/` | The agent brief, `GUIDE.md`, `context.json`, `strategy.py`, `backtest.py`, `USER.md`, checkpoints, `tested_runs.json` |
| `chats/` | Your assistant conversations |
| `assistant_memory.json` | What the agent has been asked to remember about you |
| A broker's state folder | That broker's credentials and tokens, written by the engine only |

## Desktop app and hosted preview

The downloaded app is the full product. A hosted preview of the same interface runs on the LSE website with LSE data already connected; it exists to look around, and everything that writes files or runs your code is switched off there.

- **Hosted preview does not have:** MY DATA imports and the library writes, WORKSPACE (file writes and the terminal), backtests and walk forward and Monte Carlo (they execute your Python), machine learning runs, notebooks (read only preview), the data visualisation file upload (paste and library datasets still work), the in app PDF reader (papers open as links), custom indicators, model fits, broker connections (the ticket drives the LSE demo only), your own AI agent, the connection control (no per user keys) and the update button. The manual bar replay, the charts, the screener, options, news, economics and research articles work.
- **Local browser instead of the desktop window.** Everything works except the screenshot the agent gets before each turn and absolute paths from the Attach file picker, both of which need the desktop shell.
- **Updates.** The desktop app checks for a newer release and the UPDATE button appears in the header when there is one; the hosted preview is redeployed rather than self updated.

## Privacy: what leaves your machine

Your data files, strategies, notebooks, chats and broker credentials stay on your disk. Five things leave it, each only when you use the feature.

- **Your LSE key** goes to London Strategic Edge with every live data, databank and assistant request, from your engine, never from the page.
- **Assistant messages** and the context that goes with them (page, chart symbol, open file contents, terminal tail, dataset names and shapes) go to the Veron service, and so does whatever its local tools return: the dataset list, a preview of up to 30 rows when it asks for one, and backtest statistics. The files themselves stay local; the assistant asks your terminal to run code on them here.
- **Your own agent's traffic** goes to its vendor (Anthropic or OpenAI) under your account: your messages, the brief, and whatever files it reads on your machine as part of a turn.
- **Broker credentials** go to the broker's own adapter on your machine and from there to that broker only. The engine stores them locally; London Strategic Edge never sees them.
- **Web tools** fetch pages from your machine's connection (research PDFs, the agent's fetch_url and browse); Veron's web search runs on the LSE side.

## Keyboard and mouse quick reference

The shortcuts and pointer gestures the terminal answers to, page by page.

- Escape closes the open overlay: the Connections screen, the indicator editor, the screener profile card, the research reader, the chart layout panel, a position menu, and cancels a drawing in progress. Escape or Backspace deletes the selected drawing.
- Enter submits the key fields and the template name; Enter sends a chat message.
- Chart: drag to pan, wheel to zoom, drag the price scale to free it (Auto resets), right click for the chart menu, drag the divider between price and indicator panes.
- Watchlist and library: click to chart or select; right click a dataset for Rename and Delete; drag a dataset into a folder.
- Account dock: left or right click a position row for the close menu; drag the dock's top edge to resize.
- Right rail: drag its left edge to resize; the double chevron folds it; the sash between ticket and assistant divides the height, double click resets it. Type `/` in the composer for the command menu.
- Notebook: V H T N C M P G E I and the shape letters L A R O Y D S select tools; Ctrl+Z, Ctrl+Shift+Z, Ctrl+0.
- News globe: drag rotates, wheel or pinch zooms, double click open ocean resets.

## Common questions

The questions new users ask most, with the answer and where in the app it lives.

- **Nothing shows under MARKETS.** No key yet. Paste the free key from londonstrategicedge.com/data into the connect form; the watchlist and chart fill within a moment.
- **RUN says the pinned dataset is missing.** The file's `# run:` line names a dataset that is not in your library. Import or download it, or click a dataset in the library to rewrite the pin.
- **The assistant delivered a strategy but no numbers.** It always runs the code first; if the numbers are missing, the run failed and the message says why. Ask it to fix and rerun.
- **My strategy has zero trades.** Loosen the entry conditions or check the timeframe: hourly parameters on daily data rarely fire. The assistant loosens parameters itself for up to three attempts.
- **Where did my import go?** MY DATA prints the on disk path with an open folder link; the library tree shows it under DATA, in the folder you chose.
- **A model card says SETUP.** Its libraries are not installed. Select the model and press Install in the banner; pip streams into the terminal's own Python and the tag disappears when it finishes.
- **Can I use my own AI?** Yes: pick Claude or ChatGPT in the rail's provider menu, install if asked, sign in with your own account. It gets the terminal's tools and this walkthrough.
- **Does the terminal trade for me?** No. The ticket and dock are manual. Strategies backtest; they do not place orders.
- **How do I ask about the terminal itself?** Ask the assistant. It has this walkthrough in front of it every turn and reads the full section before answering in detail.

## Glossary

The terms this walkthrough and the interface use, in alphabetical order, each with a one line definition.

- **Account dock.** The strip under the chart on MARKETS showing balance, equity, open P&L, margin and leverage, with Positions and History tabs.
- **Algo Development.** The BACKTEST mode with the code editor, the library as explorer, RUN, and the terminal dock; where strategies are written and backtested.
- **Alternative dataset (series).** An imported table with a time column that is not candles; readable inside a strategy through `data["NAME"]`.
- **Assistant.** The right rail. Either Veron (your free key) or your own agent CLI (Claude, ChatGPT) signed in on your account.
- **Autonomy.** How much your own agent may do without asking: Ask, Auto edit, or Full auto.
- **Backtest.** Running a strategy file over historical candles and reading the resulting trades, equity curve and statistics.
- **Bar replay.** The MANUAL mode: the chart advances one candle at a time from a chosen date and you trade it by hand.
- **Blueprint.** A short Python script that trains one machine learning model through `lse_terminal.ml.blueprint.train(...)`; the ML page writes it, you edit and run it.
- **Brief.** The document your own agent receives on its first turn: what the app is, where your data lives, the strategy contract, the tools, this walkthrough, and your USER.md.
- **Candles.** Open, high, low, close and volume per bar; the dataset kind that charts and backtests use.
- **Databank.** The recorded history behind the platform, downloadable into your library by symbol and timeframe with your key (Import via LSE Data).
- **Dataset.** One entry in your library: an imported file, a databank download or a sample, with a symbol, a kind and a timeframe.
- **Drawdown.** The largest fall in equity from a peak to the following trough, in money and in percent.
- **Engine.** The local Python server behind the app: it serves the interface, runs strategies, trains models and reads and writes your files.
- **Extended stats.** The second block of backtest statistics: VaR 95 and 99, CVaR, Sortino, Calmar, annualised return and volatility, exposure, average bars held.
- **Kind.** What a dataset is: candles (chartable, backtestable) or series (alternative data).
- **Level 3 data.** Order by order futures flow, shown as an order stacking ladder and the order flow; only for keys whose plan carries it.
- **Library.** Every dataset, strategy file and notebook on this machine, shown as one tree on the left of BACKTEST, MY DATA and WORKSPACE.
- **LSE key.** The free API key from londonstrategicedge.com/data that unlocks live data, the databank and Veron; stored in your local config, never in the page.
- **Manifest.** The `manifest.json` next to your imports that records what each dataset is (name, kind, rows, timeframe, folder, columns, span).
- **MCP.** The protocol through which your own agent, or any other local MCP client, calls the terminal's tools; served at `/mcp` on the engine.
- **Monte Carlo.** Resampling a strategy's closed trade P&L many times to see the spread of outcomes: drawdown percentiles and risk of ruin.
- **Pin line.** The first line of a strategy, `# run: SYMBOL TIMEFRAME`, naming the dataset it trades; RUN and the assistant's tools target it.
- **Plots.** A dict a strategy may leave, name to per bar series, drawn as small panes above the run console.
- **Profit factor.** Gross profit divided by gross loss over all closed trades.
- **Provider.** Where candles come from: `lse` (live data with your key), `userdata` (your library), or a connected broker that serves candles.
- **Sample datasets.** The ten datasets seeded on first launch (GOLD, EURUSD, SPX500, BTCUSD, SILVER, BRENT, USDJPY, NAS100, AAPL, USYIELDS) so the app works with no key.
- **Libraries panel.** Opened from the libraries badge in the MACHINE LEARNING header: every optional library with installed or not, version, download size and date, the models it unlocks, and Install buttons.
- **SETUP tag.** The mark on a machine learning model card whose libraries are not installed yet; the Install banner under the model (or the Libraries panel) puts them in place, then the tag goes.
- **Screen map.** The description of every panel and its live values that the app hands the assistant each turn, so it knows what is on your screen.
- **Secondary bar.** The row under the rail tabs listing the active tab's sub views (PRICE & CHARTS, OPTIONS, NEWS, SCREENER under MARKETS, and so on).
- **Sharpe ratio.** Return per unit of volatility of the strategy's equity curve, as the engine computes it for every run.
- **Starter strategies.** The seven example strategy files seeded into `workspace/strategies/` on first open.
- **Strategy brief.** The panel above the assistant on BACKTEST > ALGO DEVELOPMENT: dataset, approach, side, horizon, risk, costs, validation and notes as pre-set choices; Build it sends the request to the assistant.
- **Strategy.** A plain Python file that reads `df` (and optionally `params` and `data`) and leaves a `trades` list; nothing to import, no base class.
- **Template (chart).** A saved chart setup: symbol, timeframe, chart type, indicators with parameters, appearance; applied from Templates or the right click menu.
- **Tested run registry.** The engine's record of every strategy the assistant successfully backtested, used to stamp the pin line on code sent to the IDE.
- **Timeframe.** The bar size: tick, 1s, 30s, 1m, 5m, 15m, 30m, 1h, 4h, 1d, 1w on LSE data; an imported file has one native timeframe.
- **To strategy IDE.** The button on a Python code block in chat that files the code in your workspace, pinned to the dataset it was tested on.
- **Trade ticket.** The order panel at the top of the right rail on MARKETS: sell at bid, buy at ask, size, stop and target, margin figures.
- **USER.md.** Your own standing instructions to the assistant, edited from the gear in the rail and appended to everything the agents are told.
- **Walk forward.** Sweeping a strategy's parameters on each training window and measuring on the untouched window after it, fold by fold, with an efficiency ratio.
- **Watchlist.** The left column on MARKETS: every live instrument in category folders with logo, name, price and spread.
- **Win rate.** Winning trades as a share of all closed trades.
- **Workspace.** The folder of your strategy files and scripts, `~/.config/lse-terminal/workspace/`, shown in the BACKTEST and WORKSPACE explorers.
