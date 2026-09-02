"""Broker connections: the terminal side of brue-connect.

One hub, many named brokers. Every broker is just an adapter command
speaking the brue-connect protocol; connecting spawns the adapter and
runs the SPEC section 7 reconciliation, after which the broker is the
source of truth for catalog, account and positions. This is THE trading
door of the terminal: onboarded external brokers and our own demo broker
all come through here, which is why the bundled fake broker (NovaFX)
exists: it keeps the generic path honest, because nothing in this file
may ever special-case a broker name.

Local-mode only (spawns subprocesses), same rule as the algo runner.
"""
from __future__ import annotations

import json
import os
import re
import sys
import threading
import time
import urllib.request
import uuid
from functools import lru_cache
from pathlib import Path

# The data-provider contract, for offering a connected broker as a source the
# markets page can read (BrokerProvider, at the foot of this file).
from lse_terminal.contracts import (CANDLE_COLUMNS, Instrument, NotSupported,
                                    Provider, Quote)

# The dynamic connection directory: which brokers and LSE-shipped data
# sources exist is decided by OUR API at runtime, not baked into the
# installed version. Adding or delisting a connection is a server-side
# change that reaches every online terminal on its next refresh. Fail-open by design: no network -> cached copy -> local
# built-ins, so an offline user never loses their terminal. User-owned
# sources (custom API keys, userdata) are never gated by this.
DIRECTORY_URL = os.environ.get(
    "LSE_DIRECTORY_URL", "https://api.londonstrategicedge.com/sim/directory")
# The demo channel is the staging app: it sees brokers still marked dev in
# the directory (include_dev=1), so a partner can be checked there before its
# row reaches every public terminal. The shell says which channel this is.
if (os.environ.get("LSE_TERMINAL_CHANNEL") == "demo"
        and "LSE_DIRECTORY_URL" not in os.environ):
    DIRECTORY_URL += "?include_dev=1"
DIRECTORY_REFRESH_S = 6 * 3600


def fetch_directory(cache_path: Path) -> dict | None:
    try:
        req = urllib.request.Request(
            DIRECTORY_URL, headers={"User-Agent": "lse-terminal"})
        with urllib.request.urlopen(req, timeout=4) as r:
            d = json.loads(r.read())
        if not isinstance(d, dict) or "brokers" not in d:
            raise ValueError("malformed directory")
        cache_path.parent.mkdir(parents=True, exist_ok=True)
        cache_path.write_text(json.dumps(d))
        return d
    except Exception:
        try:
            return json.loads(cache_path.read_text())
        except Exception:
            return None


def connect_base(checkout: Path | None = None) -> Path:
    """Locate the brueconnect package and return its directory.

    A user install resolves the installed wheel (brueconnect is a real
    dependency, present on every machine the terminal runs on); a dev
    checkout (LSE_BRUE_CONNECT_DIR, or a sibling checkout) wins when present
    because its root is pushed onto sys.path first. Raises ImportError
    when neither exists; callers surface that as "install brue-connect".
    """
    if (checkout and (checkout / "brueconnect").is_dir()
            and str(checkout) not in sys.path):
        sys.path.insert(0, str(checkout))
    import brueconnect  # noqa: PLC0415
    return Path(brueconnect.__file__).resolve().parent


def _load_connector(connect_dir: Path):
    connect_base(connect_dir)
    from brueconnect import Connector, ConnectorError  # noqa: PLC0415
    return Connector, ConnectorError


# The adapters and the brueconnect package they import both declare
# requires-python >= 3.10, so anything older is not a candidate however it
# is named.
_MIN_ADAPTER_PY = (3, 10)


def _python_version_ok(path: str) -> bool:
    """True if `path` is a real interpreter of at least _MIN_ADAPTER_PY.

    Asking the binary itself is the only reliable test, because the name on
    disk says nothing about what is behind it: macOS ships /usr/bin/python3
    as a Command Line Tools shim pinned at 3.9 (below what the adapters
    need), and Windows ships WindowsApps stubs that are not Python at all.
    """
    import subprocess  # noqa: PLC0415
    try:
        out = subprocess.run(
            [path, "-c", "import sys;print('%d.%d' % sys.version_info[:2])"],
            capture_output=True, text=True, timeout=10)
    except Exception:
        return False  # not executable, not there, or it hung
    if out.returncode != 0:
        return False
    try:
        major, minor = (int(x) for x in out.stdout.strip().split(".")[:2])
    except ValueError:
        return False
    return (major, minor) >= _MIN_ADAPTER_PY


@lru_cache(maxsize=1)
def adapter_python() -> str:
    """The interpreter that runs adapter subprocesses.

    In a normal install this process IS a Python, so sys.executable is
    right. In the FROZEN desktop sidecar sys.executable is the lset-server
    binary: handing that an adapter .py would just boot a second engine, so
    the frozen build must borrow a real Python from the machine
    (BRUE_CONNECT_PYTHON overrides the search). Cached: the search shells
    out to every candidate, and the answer cannot change within a run.
    """
    if not getattr(sys, "frozen", False):
        return sys.executable
    override = os.environ.get("BRUE_CONNECT_PYTHON")
    if override:
        return override
    import shutil  # noqa: PLC0415
    candidates: list[str] = []
    if sys.platform == "darwin":
        # Named BEFORE the PATH search on purpose. A Finder-launched .app
        # inherits launchd's minimal PATH, so a Homebrew or python.org
        # interpreter can be installed and still be invisible to which();
        # and the /usr/bin/python3 that IS always on that PATH pops the
        # "install the command line developer tools" dialog when the tools
        # are absent, which would block this search behind a modal the user
        # never asked for. Finding a real Python first avoids touching it.
        candidates += [p for p in (
            "/opt/homebrew/bin/python3",
            "/usr/local/bin/python3",
            str(Path.home() / ".local" / "bin" / "python3"),
            "/Library/Frameworks/Python.framework/Versions/Current/bin/python3",
        ) if os.path.isfile(p)]
    for name in ("python3", "python"):
        found = shutil.which(name)
        # Windows ships fake python3.exe/python.exe stubs in WindowsApps
        # that open the Microsoft Store instead of running the script; one
        # of those "interpreters" is how every adapter died instantly on
        # the first frozen build that spawned them.
        if found and "windowsapps" not in found.lower():
            candidates.append(found)
    for path in candidates:
        if _python_version_ok(path):
            return path
    # Nothing usable. Return the best-looking name anyway so the spawn still
    # happens and fails in the adapter's own error path, which surfaces to
    # the user, rather than raising from inside the broker directory.
    return candidates[0] if candidates else "python3"


# Bundled adapters, keyed by registry name. External brokers onboard by
# appearing here (a user config entry) with their own adapter command;
# the hub itself treats every entry identically. Adapters ship INSIDE the
# brueconnect package, so their files exist wherever the package does.
def builtin_brokers(base: Path) -> dict:
    py = adapter_python()
    return {
        "paper": {
            "label": "Paper (built-in simulator)",
            "cmd": [py, str(base / "adapters" / "paper" / "paper_adapter.py"),
                    "--tick-ms", "200", "--warmup-bars", "30"],
        },
        "novafx": {
            "label": "NovaFX (fictional demo broker)",
            "cmd": [py, str(base / "adapters" / "novafx" / "novafx_adapter.py"),
                    "--tick-ms", "200", "--warmup-bars", "30"],
        },
        # Our own demo account, behind the same contract as everyone else's
        # broker. It is listed here rather than special-cased anywhere: the
        # point of the adapter is that this row is ordinary.
        "lse-sim": {
            "label": "LSE Demo Account",
            "cmd": [py, str(base / "adapters" / "lse_sim" / "lse_sim_adapter.py")],
            # The user's own key, from the terminal's config, passed as env so
            # it never travels in a protocol message (SPEC 8.5).
            "needs_lse_key": True,
        },
    }


# Sim brokers whose adapter ships inside the brueconnect package and whose
# public endpoint is announced by the hosted broker directory. Each entry names the
# bundled adapter file and how to turn a directory endpoint into the env that
# adapter reads, so the same adapter code the conformance trial certified runs
# unchanged, just pointed at the public host instead of loopback. A broker
# joins this map only once its adapter is bundled AND verified end to end over
# the public endpoint; listing one whose adapter is not here just means the
# directory shows it but this terminal cannot spawn it (handled like any
# listed-but-not-installed broker), never a broken connect.
def _http_base(ep: dict) -> str:
    scheme = "https" if ep.get("tls") else "http"
    return f"{scheme}://{ep['host']}:{ep['port']}"


def _ws_base(ep: dict) -> str:
    scheme = "wss" if ep.get("tls") else "ws"
    return f"{scheme}://{ep['host']}:{ep['port']}"


def _addr(ep: dict) -> str:
    # Raw TCP venues (FIX, the binary link, gRPC) dial host:port, not a URL.
    return f"{ep['host']}:{ep['port']}"


SIM_ADAPTERS = {
    # Northgate deals FIX 4.4 on a raw socket; the adapter dials host:port and
    # runs the whole session layer itself (logon, sequence numbers,
    # heartbeats, resend) with nothing but `socket`.
    "northgate": {
        "path": ("adapters", "northgate", "northgate_adapter.py"),
        "env": lambda ep, extra: {"NORTHGATE_ADDR": _addr(ep)},
    },
    # Sable Point is gRPC, implemented down to HTTP/2 frames, HPACK and the
    # protobuf wire format in pure stdlib, because grpcio is absent from most
    # machines this ships to and a pip dependency would make the broker
    # unconnectable for those users.
    "sablepoint": {
        "path": ("adapters", "sablepoint", "sablepoint_adapter.py"),
        "env": lambda ep, extra: {"SABLEPOINT_ADDR": _addr(ep)},
    },
    # Helix is signed REST on one port and a websocket feed on another, so the
    # feed port comes from the directory row's extra rather than being guessed
    # (it is not simply REST+1 by contract, only by today's coincidence).
    "helix": {
        "path": ("adapters", "helix", "helix_adapter.py"),
        "env": lambda ep, extra: {
            "HELIX_BASE_URL": _http_base(ep),
            "HELIX_WS_URL": "{}://{}:{}".format(
                "wss" if ep.get("tls") else "ws", ep["host"],
                extra.get("ws_port") or (int(ep["port"]) + 1)),
        },
    },
    "quantex": {
        "path": ("adapters", "quantex", "quantex_adapter.py"),
        "env": lambda ep, extra: {"QUANTEX_ADDR": _addr(ep)},
    },
    "vertex": {
        "path": ("adapters", "vertex", "vertex_adapter.py"),
        "env": lambda ep, extra: {"VERTEX_WS_URL": _ws_base(ep)},
    },
    "pemberton": {
        "path": ("adapters", "pemberton", "pemberton_adapter.py"),
        "env": lambda ep, extra: {"PEMBERTON_BASE_URL": _http_base(ep)},
    },
    "atlas": {
        "path": ("adapters", "atlas", "atlas_adapter.py"),
        "env": lambda ep, extra: {"ATLAS_BASE_URL": _http_base(ep)},
    },
    "meridian": {
        "path": ("adapters", "meridian", "meridian_adapter.py"),
        # MERIDIAN_AUTH=login: a human sits at this terminal, so Meridian is
        # connected with the interactive "Log in with Meridian" flow (the
        # user's own account) rather than machine self-registration (a fresh
        # anonymous account per state dir). Headless users of the same
        # adapter (conformance, bots) simply do not set it.
        "env": lambda ep, extra: {"MERIDIAN_BASE_URL": _http_base(ep),
                                  "MERIDIAN_AUTH": "login"},
    },
}


def directory_env(key: str, extra: dict) -> dict:
    """Fixed, documented demo settings a directory row hands its adapter.

    Some staged venues issue one fixed demo login in their documentation
    (a FIX CompID and user, a demo token) and ask nothing of the user. Those
    ride the row's `extra.env`, so the terminal carries no per-broker
    credential code and a row that says "no key entry required" is true.
    Guarded: only this broker's own names (NORTHGATE_* for northgate),
    string values, capped, so a row can never reach PATH, PYTHONPATH or
    another broker's process. The user's own typed BRUE_CRED_* still win
    inside adapters that read both.
    """
    env = extra.get("env") if isinstance(extra, dict) else None
    if not isinstance(env, dict):
        return {}
    prefix = re.sub(r"[^A-Z0-9]", "_", str(key).upper()) + "_"
    out = {}
    for k, v in env.items():
        if (isinstance(k, str) and isinstance(v, str) and k.startswith(prefix)
                and re.fullmatch(r"[A-Z0-9_]{1,64}", k) and len(v) <= 256):
            out[k] = v
    return out


def directory_brokers(base: Path, directory: dict | None, skip=()) -> dict:
    """Spawnable entries for directory-listed brokers whose adapter is bundled.

    The directory row carries the public endpoint; the SIM_ADAPTERS map carries
    how this build reaches that broker's adapter and what env feeds it the
    endpoint. A listed broker with no bundled adapter, or a bundled adapter file
    that is missing from this install, is skipped here and simply does not gain
    a connect action, exactly like any broker listed upstream but absent
    locally.
    """
    out: dict = {}
    for b in (directory or {}).get("brokers", []):
        key, ep = b.get("key"), b.get("endpoint")
        spec = SIM_ADAPTERS.get(key)
        if key in skip or not key or not ep or spec is None:
            continue
        adapter = base.joinpath(*spec["path"])
        if not adapter.is_file():
            continue
        out[key] = {
            "label": b.get("label") or key,
            "cmd": [adapter_python(), str(adapter)],
            # The endpoint is public config, not a secret, so it rides env like
            # any other adapter knob; the broker's own credentials (if its
            # credential_form asks for any) still land only in its 700 state dir.
            "endpoint_env": {**spec["env"](ep, b.get("extra") or {}),
                             **directory_env(key, b.get("extra") or {})},
        }
    return out


def registry_brokers(skip=()) -> dict:
    """Profiles the USER registered, from the brue-connect registry.

    This is the open-source door: `brueconnect add mybroker --command ...`
    and the broker appears in this terminal's connection picker on the next
    read, with no change here and no server-side listing. Nothing about it is
    second class; it goes through the same hub as ours.

    `skip` is the set of names we already run ourselves (the registry ships
    its own entries for the bundled adapters, and we run those with
    terminal-tuned arguments). Passed in rather than written here, because
    naming a broker in this file is the one thing it must never do.
    """
    try:
        from brueconnect import registry  # noqa: PLC0415
        reg = registry.load()
    except Exception:
        return {}
    out = {}
    for name, prof in (reg.get("brokers") or {}).items():
        if name in skip or not prof.get("command"):
            continue
        out[name] = {"label": prof.get("description") or name,
                     "cmd": None,  # resolved at spawn, so {state} expands
                     # kept for identity fingerprinting only; the registry
                     # remains the authority on how to actually spawn it
                     "command": prof["command"],
                     "registered": True}
    return out


class BrokerHub:
    def __init__(self, connect_dir: Path, identity_cache: Path | None = None):
        self.connect_dir = connect_dir
        try:
            # The brueconnect package dir: where bundled adapters live, for
            # both the builtins and the directory-listed sim brokers.
            self.base = connect_base(connect_dir)
            self._installed = builtin_brokers(self.base)
        except ImportError:
            # no wheel and no checkout: an empty broker list, never a crash
            self.base = None
            self._installed = {}
        self.directory: dict | None = None
        self.conns: dict[str, object] = {}
        self.quotes: dict[str, dict[str, dict]] = {}
        # Brokers mid-login (SPEC 1.6 interactive auth): the adapter is
        # spawned and waiting on its loopback for the user to finish the
        # broker's own login page. broker -> {"c", "url", "expires"}. Kept
        # OUT of self.conns: a half-authenticated adapter must never answer
        # quotes/orders paths as if it were a connection.
        self.pending_auth: dict[str, dict] = {}
        # Last known account list per broker, so a CONNECTED broker can still
        # show you every account the login reaches and mark the one in use.
        # Read once per connect rather than per status poll: the picker needs
        # the list, not a live balance feed for accounts nobody is trading.
        self.account_lists: dict[str, list] = {}
        self.lock = threading.RLock()
        # One lock per broker for spawning, so a probe of a slow broker never
        # blocks quotes or an order on a different one, and two probes of the
        # SAME broker cannot both spawn its adapter (which for a broker that
        # opens an account on first run means two accounts).
        self._spawn_locks: dict[str, threading.Lock] = {}
        # Last handshake identity per broker, so the picker can show a
        # broker's own name BEFORE it is connected. Without this the first
        # paint of the menu can only show the profile name, and every row
        # would change under the user's cursor on connect.
        self._identity_cache = identity_cache
        self._remembered: dict[str, dict] = self._load_identities()
        self.registry: dict = {}
        self._rebuild_registry()

    def _rebuild_registry(self):
        """The visible broker set: what we ship, what the directory allows,
        plus whatever the user linked themselves.

        Built whole and rebound in one statement. Mutating the live dict in
        place let a concurrent list_brokers() iterate a half-built registry.

        The user's own registry is re-read here rather than cached, so a
        broker linked with `brueconnect add` while the terminal is running
        shows up on the next look instead of after a restart. It is one small
        JSON file; a menu that is right is worth a stat and a read.
        """
        reg = dict(self._installed)
        if self.directory:
            listed = {b["key"]: b for b in self.directory.get("brokers", [])
                      if isinstance(b, dict) and b.get("key")}
            reg = {}
            for k, v in self._installed.items():
                if k in listed:
                    reg[k] = {**v, "label": listed[k].get("label") or v["label"]}
                elif v.get("needs_lse_key"):
                    # Our own demo account rides the user's LSE key; it is not
                    # a third-party broker listing, so it is absent from the
                    # public directory. Filtering it out here would drop the
                    # BUILTIN too and orphan the ticket's demo path: the ticket
                    # would fall back to paper while the account dock kept
                    # painting a demo account it could no longer reach.
                    # Directory rows govern third-party brokers; a key-gated
                    # builtin is governed by the key.
                    reg[k] = dict(v)
        # Fleet-listed brokers whose adapter we bundle (endpoint from the
        # directory). Added before the user registry so a user's own profile of
        # the same name still wins below via setdefault.
        if self.base is not None:
            for name, entry in directory_brokers(
                    self.base, self.directory, skip=set(self._installed)).items():
                reg.setdefault(name, entry)
        for name, entry in registry_brokers(skip=set(self._installed)).items():
            reg.setdefault(name, entry)
        # A directory broker this build cannot spawn: its adapter shipped in a
        # newer release than the one running (or is not bundled at all). It
        # is listed anyway, as a row that says so, because a broker that
        # silently never appears teaches the user nothing; "update to use it"
        # does. No command, so nothing here can ever try to start it.
        if self.directory:
            for b in self.directory.get("brokers", []):
                k = b.get("key") if isinstance(b, dict) else None
                if k and k not in reg:
                    reg[k] = {"label": b.get("label") or k,
                              "update_required": True}
        # A broker holding a live connection stays listed even if the hosted
        # directory dropped it or the user unlinked its profile. The session is
        # real either way, and delisting it stranded the adapter: it vanished
        # from the picker, so nothing could offer to close it, and disconnect
        # refused it as an unknown broker. It leaves the list when it is
        # disconnected, not before.
        for name in list(self.conns):
            if name not in reg:
                prev = self.registry.get(name) or {}
                reg[name] = {**prev, "label": prev.get("label") or name,
                             "unlinked": True}
        self.registry = reg

    # == remembered identity =============================================
    # Cached against the adapter command that produced it. A profile whose
    # command changed is a different broker wearing an old name, and showing
    # the previous broker's name for it is the one mistake a connection
    # picker must never make.
    CACHE_VERSION = 2

    def _load_identities(self) -> dict:
        if self._identity_cache is None:
            return {}
        try:
            d = json.loads(self._identity_cache.read_text())
        except Exception:
            return {}
        if not isinstance(d, dict) or d.get("v") != self.CACHE_VERSION:
            return {}  # a cache is disposable; re-learn rather than guess
        entries = d.get("brokers")
        return entries if isinstance(entries, dict) else {}

    def _fingerprint(self, broker: str) -> str:
        """What this profile points at right now, as a comparable string."""
        entry = self.registry.get(broker) or {}
        cmd = entry.get("cmd")
        return " ".join(cmd) if cmd else str(entry.get("command", ""))

    def identity_of(self, broker: str) -> dict:
        rec = self._remembered.get(broker) or {}
        if rec.get("cmd") != self._fingerprint(broker):
            return {}
        ident = rec.get("identity")
        return ident if isinstance(ident, dict) else {}

    def _remember(self, broker: str, identity: dict):
        with self.lock:
            self._remembered[broker] = {"cmd": self._fingerprint(broker),
                                        "identity": identity}
            if self._identity_cache is None:
                return
            try:
                self._identity_cache.parent.mkdir(parents=True, exist_ok=True)
                tmp = self._identity_cache.with_suffix(".tmp")
                tmp.write_text(json.dumps(
                    {"v": self.CACHE_VERSION, "brokers": self._remembered},
                    indent=1))
                tmp.replace(self._identity_cache)
            except OSError:
                pass  # a picker that forgets a name is not worth an error

    def _spawn_lock(self, broker: str) -> threading.Lock:
        with self.lock:
            return self._spawn_locks.setdefault(broker, threading.Lock())

    def apply_directory(self, directory: dict | None):
        """Filter the installed adapters by the remote directory.

        Directory present: only brokers it lists appear, and its labels win.
        Directory absent (offline, no cache): every installed adapter shows.
        An entry the directory lists but we don't have installed is skipped.

        The directory gates OUR shipped adapters only. A broker the user
        registered themselves is theirs, on their machine, and is never
        filtered by our listing: the whole premise is that they do not need
        our permission to connect their own broker.
        """
        self.directory = directory
        self._rebuild_registry()

    def _require(self, broker: str):
        if broker not in self.registry:
            # Re-read before refusing: the name may have been registered
            # since the last look, and "unknown broker" for one the user just
            # linked is the wrong answer.
            self._rebuild_registry()
        if broker not in self.registry:
            raise KeyError(f"unknown broker {broker!r}")

    def _conn(self, broker: str):
        c = self.conns.get(broker)
        if c is None or not c.alive:
            raise LookupError(f"broker {broker!r} not connected")
        return c

    # == lifecycle =======================================================
    def blocked(self, broker: str) -> str | None:
        """Why this broker cannot be connected yet, or None.

        Asked BEFORE spawning, so a platform can say "needs your LSE key" on
        the row instead of letting the user click and read a failure. One
        source of truth: _new_connector raises with this same sentence.
        """
        entry = self.registry.get(broker) or {}
        if entry.get("update_required"):
            return "update the terminal to use this broker"
        if entry.get("needs_lse_key"):
            from . import config as cfg  # noqa: PLC0415
            if not cfg.get_lse_api_key():
                return "needs your LSE API key"
        return None

    def _new_connector(self, broker: str):
        """An unstarted connector for a broker, however it is configured."""
        Connector, _ = _load_connector(self.connect_dir)
        entry = self.registry[broker]
        if entry.get("update_required"):
            raise LookupError(f"{entry['label']}: {self.blocked(broker)}")
        if not entry.get("cmd"):
            # A registered profile: the registry owns its command, env and
            # private state directory, so `{state}` expands and the broker's
            # credentials stay in a 700 directory of its own.
            return Connector.for_broker(broker)
        # A bundled adapter. It gets the same private state directory a
        # registered profile gets, because "where does this broker keep its
        # things" should have one answer regardless of who shipped it.
        from brueconnect import registry  # noqa: PLC0415
        env = dict(os.environ)
        env["BRUE_BROKER_STATE"] = registry.state_dir(broker)
        # Whatever the user typed into this broker's credential form, as
        # BRUE_CRED_* (SPEC 8.5). Env at spawn, never a protocol message,
        # and read from a 0600 file on this machine only. Registered profiles
        # get the same treatment inside registry.resolve().
        env.update(registry.credential_env(broker))
        # Which of the login's accounts this process deals on (SPEC 1.7).
        # Bundled adapters build their env here rather than through
        # registry.resolve(), so without this the user's pick was stored,
        # shown, and then silently ignored: every process bound itself to the
        # login's primary.
        env.update(registry.account_env(broker))
        # The spawned adapter imports brueconnect too. A python-installed
        # terminal resolves it like we did, but the adapter's interpreter is
        # NOT this process (see adapter_python), so give it the package's
        # parent dir explicitly; without this the frozen desktop build spawns
        # adapters that die on their first import.
        if self.base is not None:
            env["PYTHONPATH"] = os.pathsep.join(
                [str(self.base.parent)]
                + ([env["PYTHONPATH"]] if env.get("PYTHONPATH") else []))
        # A directory-listed broker points its bundled adapter at the public
        # endpoint the directory announced (host:port env); everything else
        # about spawning it is identical to any other bundled adapter.
        env.update(entry.get("endpoint_env") or {})
        if entry.get("needs_lse_key"):
            why = self.blocked(broker)
            if why:
                raise LookupError(f"{entry['label']} {why}; add it in the "
                                  "connection menu first")
            # The user's key, from their own config, as environment. Never a
            # protocol message (SPEC 8.5), and never written to the registry.
            from . import config as cfg  # noqa: PLC0415
            env["LSE_API_KEY"] = cfg.get_lse_api_key() or ""
        return Connector(list(entry["cmd"]), env=env)

    def connect(self, broker: str) -> dict:
        self._require(broker)
        with self._spawn_lock(broker):
            with self.lock:
                c = self.conns.pop(broker, None)
                if c is not None and c.alive:
                    self.conns[broker] = c
                    return self.status_one(broker)
            if c is not None:
                # A dead-but-not-buried connection from a crashed adapter.
                # Overwriting the slot without closing it left the old process
                # unreachable if it was hung rather than gone.
                try:
                    c.close()
                except Exception:
                    pass
            # A login already in flight? Poll it rather than spawning a
            # second adapter: connect() doubles as the "is the user done on
            # the broker's page yet" poll, so it must be safe to call every
            # couple of seconds without abandoning the attempt each time.
            pending = self.pending_auth.get(broker)
            if pending is not None:
                c = pending["c"]
                if not c.alive:
                    self.pending_auth.pop(broker, None)
                else:
                    st = c.request("auth.status", {})
                    if st.get("authenticated"):
                        if pending.get("accounts") and not self._chosen(broker):
                            # Logged in, waiting on which account. Hold the
                            # question open until it is answered.
                            return self.status_one(broker)
                        # Logged in and settled: retire the chooser. The
                        # session that actually trades is spawned below, bound
                        # to the account, because the account is fixed before
                        # the process exists (SPEC 1.7).
                        self.pending_auth.pop(broker, None)
                        try:
                            c.close()
                        except Exception:
                            pass
                        c = None
                    else:
                        if time.time() >= pending["expires"] - 10:
                            # The attempt timed out (or is about to); a fresh
                            # begin gets a fresh loopback and url, so the
                            # button the user eventually clicks always works.
                            b = c.request("auth.begin", {})
                            pending["url"] = b.get("url")
                            pending["expires"] = time.time() + float(
                                b.get("expires_in") or 300)
                        # Still waiting on the human. Only this branch
                        # returns: a chooser that has been retired must fall
                        # through and spawn the bound session below.
                        return self.status_one(broker)
            # The spawn and handshake happen OUTSIDE the hub lock: connecting
            # to a real broker is a login over the network, and holding the
            # lock across it froze every other broker's quotes and orders.
            # The per-broker spawn lock still makes this one exclusive.
            c = self._new_connector(broker)
            try:
                # hello is cold (SPEC 3.1), so the capability check costs the
                # broker nothing. THE ACCOUNT GATE LIVES HERE, on the path
                # every connect takes, not only after a fresh login: with a
                # stored token the adapter would otherwise bind the login's
                # PRIMARY and open a session on it, which is how a user ends
                # up trading a live account they never chose.
                c.hello()
                gate = self._account_gate(broker, c)
                if gate is not None:
                    return gate
                c.reconcile()
            except BaseException as e:
                if getattr(e, "code", None) == "auth_required" and c.alive:
                    # Not a failure: the broker wants its USER, not better
                    # machinery (SPEC 1.6). Keep the adapter alive on its
                    # loopback and hand the UI the url to open.
                    b = c.request("auth.begin", {})
                    self.pending_auth[broker] = {
                        "c": c, "url": b.get("url"),
                        "expires": time.time() + float(
                            b.get("expires_in") or 300)}
                    return self.status_one(broker)
                # A failed connect used to leave the adapter process running:
                # nothing had stored it, so nothing could ever close it, and
                # every retry against a flaky broker leaked another login.
                try:
                    c.close()
                except Exception:
                    pass
                raise
            return self._adopt(broker, c)

    def _adopt(self, broker: str, c) -> dict:
        """Post-handshake bookkeeping for a connection that is now real."""
        if ((c.handshake.get("capabilities") or {}).get("accounts") or {}).get("multi"):
            try:
                self.account_lists[broker] = (
                    c.request("accounts.list", {}).get("accounts") or [])
            except Exception:  # noqa: BLE001 - the connection is fine either
                pass           # way; the picker just shows what it last knew
        self._remember(broker, c.identity())
        with self.lock:
            # one live quote cache per broker, fed by the event stream
            self.quotes[broker] = {}

        def _on_quote(data, _b=broker):
            # Fetched, not indexed: this runs on the adapter's reader
            # thread and disconnect() removes the cache, so a tick landing
            # during teardown would raise (silently, inside the client's
            # handler loop) on every quote until the pipe closed.
            cache = self.quotes.get(_b)
            if cache is not None:
                cache[data.get("symbol")] = {
                    "bid": data.get("bid"), "ask": data.get("ask"),
                    "time": data.get("time")}
        c.on("quote", _on_quote)
        # NOTHING is subscribed here. Connecting used to subscribe to the
        # broker's entire catalog, which is fine for a five-instrument
        # simulator and absurd for a real one: our own demo broker deals
        # 4,189, so a connect would have asked its price board for every
        # symbol on earth to populate a panel showing one. The ticket asks
        # for what it displays, through subscribe() below.
        with self.lock:
            self.conns[broker] = c
        return self.status_one(broker)

    def set_credentials(self, broker: str, values: dict) -> dict:
        """Store the user's own broker credentials for this profile.

        They live in the profile's private state directory on THIS machine
        and reach the adapter as environment at spawn; they never travel to
        us, never enter a protocol message, and are never returned by any
        endpoint. A connected broker is disconnected so the next connect
        actually uses the new key rather than the session opened with the old
        one.
        """
        self._require(broker)
        from brueconnect import registry  # noqa: PLC0415
        stored = registry.set_credentials(broker, values)
        if broker in self.conns or broker in self.pending_auth:
            self.disconnect(broker)
        return {"broker": broker, "stored": stored}

    def _chosen(self, broker: str) -> str:
        from brueconnect import registry  # noqa: PLC0415
        return registry.get_account(broker)

    def _account_gate(self, broker: str, c):
        """None to carry on connecting, or a status asking which account.

        A broker whose login reaches one account answers itself: that is not
        a choice, so it is bound silently and the user never sees a chooser
        they had no decision to make.
        """
        from brueconnect import registry  # noqa: PLC0415
        multi = ((c.handshake.get("capabilities") or {})
                 .get("accounts") or {}).get("multi")
        if not multi or self._chosen(broker):
            return None
        rows = (c.request("accounts.list", {}).get("accounts") or [])
        self.account_lists[broker] = rows
        if len(rows) == 1:
            registry.set_account(broker, rows[0].get("id"))
            return None
        self.pending_auth[broker] = {
            "c": c, "url": None, "accounts": rows,
            "expires": time.time() + 3600}
        return self.status_one(broker)

    def choose_account(self, broker: str, account_id: str) -> dict:
        """Bind this profile to one of the login's accounts.

        The choice is stored, any live session is dropped, and the next
        connect spawns a process bound to it. Switching account is therefore
        a new process by construction, never a swap underneath open positions
        (SPEC 1.7).
        """
        self._require(broker)
        from brueconnect import registry  # noqa: PLC0415
        registry.set_account(broker, account_id)
        if broker in self.conns or broker in self.pending_auth:
            self.disconnect(broker)
        return self.connect(broker)

    def auth_url(self, broker: str) -> str | None:
        """The url the user's browser must visit to finish connecting, if a
        login is pending. The server's auth/open endpoint reads this instead
        of trusting a url from the page (nothing the frontend sends decides
        what gets opened)."""
        pending = self.pending_auth.get(broker)
        return pending["url"] if pending else None

    def disconnect(self, broker: str) -> dict:
        self._require(broker)
        with self.lock:
            c = self.conns.pop(broker, None)
            if c is not None:
                try:
                    c.close()
                except Exception:
                    pass
            # An abandoned login dies with the disconnect too, so "disconnect"
            # always means "nothing of this broker is running any more".
            pending = self.pending_auth.pop(broker, None)
            if pending is not None:
                try:
                    pending["c"].close()
                except Exception:
                    pass
            self.quotes.pop(broker, None)
        # Arming needs no cleanup: it lives on the Connector, which just went
        # away, so a reconnect to real money is a fresh decision by
        # construction rather than by remembering to forget.
        return {"broker": broker, "connected": False}

    # == arming ==========================================================
    # The rule itself lives in brueconnect.Connector: one definition of "real
    # money", one enforcement point, one way to consent, shared with the
    # strategy runner and the brue package. This is the HTTP shape of it, and
    # nothing more.
    def is_paper(self, broker: str) -> bool:
        c = self.conns.get(broker)
        if c is not None:
            return c.is_paper
        # Not connected: judge on what it said last time, through the SDK's own
        # comparison so this file never spells out what counts as paper.
        # Silence therefore reads as real money, not as safe.
        Connector, _ = _load_connector(self.connect_dir)
        return Connector.mode_is_paper(self.identity_of(broker).get("mode"))

    def arm(self, broker: str, armed: bool = True,
            reason: str = "armed from the terminal") -> dict:
        self._require(broker)   # an unknown name is a 404, not a 409
        c = self._conn(broker)  # and arming needs a connection to arm
        if armed:
            c.arm(reason)
        else:
            c.disarm()
        return {"broker": broker, "armed": c.armed, "reason": c.armed_for}

    # == views ===========================================================
    def status_one(self, broker: str) -> dict:
        self._require(broker)
        c = self.conns.get(broker)
        alive = c is not None and c.alive
        entry = self.registry[broker]
        # `broker` (the profile name the user chose) is the identity and is
        # always present; `identity` is the broker's own words about itself,
        # live if connected and last-seen otherwise, and is display only.
        # SPEC 3.1 forbids reading behaviour out of it, so nothing below this
        # line may branch on it.
        identity = c.identity() if alive else self.identity_of(broker)
        out = {"broker": broker, "label": entry["label"],
               "registered": bool(entry.get("registered")),
               "unlinked": bool(entry.get("unlinked")),
               "connected": alive,
               "identity": identity,
               "armed": bool(alive and c.armed),
               "fresh": alive}
        try:
            from brueconnect import registry  # noqa: PLC0415
            acct = registry.get_account(broker)
            if acct:
                out["account_id"] = acct
        except Exception:  # noqa: BLE001 - a picker row must never fail on this
            pass
        blocked = self.blocked(broker)
        out["ready"] = blocked is None
        if blocked:
            out["blocked"] = blocked
        if entry.get("update_required"):
            out["update_required"] = True
        pending = self.pending_auth.get(broker)
        # The account list travels with the row whether connected or not, so
        # the card can always show which account is in use and what else this
        # login reaches, rather than hiding the choice behind a button.
        known = self.account_lists.get(broker)
        if known:
            out["accounts"] = known
        if pending is not None and not alive:
            # Mid-login: the adapter waits on its loopback for the user to
            # finish the broker's page. The url is the whole story the UI
            # needs (it renders the "Log in with <broker>" button from this).
            rows = pending.get("accounts")
            if rows:
                # Logged in, waiting on which account. The url is deliberately
                # NOT offered here: the login is done, and showing it again
                # would invite a second, pointless trip to the browser.
                out["needs_account"] = True
                out["accounts"] = rows
            else:
                out["auth_pending"] = True
                out["auth_url"] = pending["url"]
        if alive:
            out["broker_name"] = c.handshake.get("broker")
            out["mode"] = c.handshake.get("mode")
            out["symbols"] = sorted(list(c.catalog))
            # What this broker can DO, verbatim from its handshake, so the UI
            # can offer only what exists (SPEC 3: absent from capabilities is
            # absent from the broker; offering it anyway and eating the error
            # is the forbidden silent path). Unlike `identity` this is meant
            # to be branched on.
            out["capabilities"] = c.handshake.get("capabilities") or {}
            # A broker that says it is degraded gets to say so in the UI. It
            # is the one thing a user cannot work out for themselves: a capped
            # stream looks exactly like a quiet market.
            sess = getattr(c, "session_state", None)
            if isinstance(sess, dict) and sess.get("state") != "connected":
                out["session"] = sess
        elif identity.get("mode"):
            # remembered from the last connect, so a live venue is still
            # flagged as live in the menu before anything is spawned
            out["mode"] = identity["mode"]
        return out

    def list_brokers(self) -> list[dict]:
        self._rebuild_registry()  # a broker linked a moment ago is listed now
        return [self.status_one(b) for b in list(self.registry)]

    def probe(self, broker: str, force: bool = False) -> dict:
        """Learn what a broker calls itself, as cheaply as it can be learned.

        Spawns the adapter, sends `hello`, remembers the answer and shuts it
        down. At the protocol level that is the whole conversation: nothing is
        subscribed, no account is read, no order path is touched.

        What it costs at the BROKER depends on the adapter, and it is not
        nothing: an adapter that authenticates in its startup path logs in
        before it can answer anything, so drawing a menu row can cost a
        session (measured on our own reference venue: one auth, one account
        read, one stream). Hence once per broker, cached, and never repeated
        while the answer still stands. SPEC 3.1 asks adapters to keep `hello`
        answerable cold for exactly this reason.
        """
        self._require(broker)
        with self._spawn_lock(broker):
            c = self.conns.get(broker)
            if c is not None and c.alive:
                return self.status_one(broker)
            # Re-checked inside the lock: three tabs opening the menu at once
            # used to spawn three adapters, and for a broker that opens an
            # account on first run that is three accounts.
            if not force and self.identity_of(broker).get("display_name"):
                return self.status_one(broker)
            c = self._new_connector(broker)
            try:
                c.hello(timeout=8.0)
                self._remember(broker, c.identity())
            finally:
                try:
                    c.close()
                except Exception:
                    pass
        return self.status_one(broker)

    def catalog(self, broker: str) -> list[dict]:
        c = self._conn(broker)
        # The broker told us its terms changed but did not send the new ones,
        # so re-read before answering rather than handing back what we know is
        # out of date (SPEC 5). Done here, on a request thread, because the
        # event arrives on the reader thread and cannot make requests.
        if getattr(c, "catalog_stale", False):
            try:
                c.refresh_catalog()
            except Exception:
                pass  # stale beats nothing; the flag stays set and we retry
        # Snapshot first. The reader thread deletes symbols from this dict when
        # the broker delists or expires one, so reading it in two steps could
        # sort a key and then fail to find it.
        cat = dict(c.catalog)
        return [cat[s] for s in sorted(cat)]

    def connector(self, broker: str):
        """The live connection for a broker, for callers that need to speak
        the protocol directly (the data provider's candle reads). Raises the
        same way every other accessor does when the broker is not connected.
        """
        return self._conn(broker)

    def account(self, broker: str) -> dict:
        c = self._conn(broker)
        return c.request("account.get")

    def positions(self, broker: str) -> list[dict]:
        c = self._conn(broker)
        return c.request("positions.list").get("positions", [])

    def subscribe(self, broker: str, symbols: list[str]) -> dict:
        """Stream quotes for these symbols and nothing else.

        Idempotent and cheap to call on every symbol change: the adapter is
        told what the user is looking at, which is the only thing a terminal
        panel needs priced. A broker with no quote stream (SPEC 3) is a no-op
        rather than an error, so a REST-only broker still trades.
        """
        c = self._conn(broker)
        if not c.handshake.get("capabilities", {}).get("data", {}).get("quotes"):
            return {"subscribed": [], "refused": [], "quotes": False}
        # Paging and the broker's declared cap are the SDK's job, so this is
        # not a third place that guesses at batch sizes. `refused` is passed
        # straight through: a caller that asked for a basket of forty on a
        # broker that serves thirty must find out which ten are unpriced.
        out = c.subscribe([s for s in symbols if s])
        out["quotes"] = True
        return out

    def latest_quotes(self, broker: str) -> dict:
        self._conn(broker)  # raises if not connected
        # A COPY. The adapter's reader thread adds a key to this dict for
        # every new symbol it sees, and handing the live dict to the response
        # serialiser raised "dictionary keys changed during iteration" mid
        # response (reproduced against fastapi's encoder). One shallow copy
        # per poll is enough: the per-symbol dicts are replaced wholesale by
        # the quote handler, never mutated in place.
        return dict(self.quotes.get(broker, {}))

    # == trading =========================================================
    def order(self, broker: str, symbol: str, side: str, qty: float,
              sl=None, tp=None, otype: str = "market",
              price=None, stop_price=None) -> dict:
        c = self._conn(broker)
        client_id = f"lset-{uuid.uuid4().hex[:12]}"
        params = {"client_id": client_id, "symbol": symbol,
                  "side": side, "qty": qty}
        pending = otype and otype != "market"
        if pending:
            # SPEC 4: limit and stop both carry their level in `price`;
            # stop_limit is the only type with a distinct `stop_price`. The
            # level is duplicated into `stop_price` for a plain stop because
            # deployed adapters read it as a documented alias (quantex docs
            # 6.1), and one field name must not decide whether an order rests.
            params["type"] = otype
            if price is not None:
                params["price"] = price
            if otype == "stop" and stop_price is None:
                stop_price = price
            if stop_price is not None:
                params["stop_price"] = stop_price
        if sl:
            params["sl"] = sl
        if tp:
            params["tp"] = tp
        mark = c.mark()
        res = c.request("order.place", params)
        out = {"order_id": res.get("order_id"), "client_id": client_id,
               "status": res.get("status") or "accepted"}
        # acceptance is transport-level (SPEC); the outcome is an event.
        # Wait briefly for the fill so the ticket can answer like the sim
        # path does; a slow broker just leaves status "accepted". The
        # rejected check is a history scan from `mark`, so a reject that
        # raced the fill wait cannot be missed. A pending order RESTS by
        # definition, so it gets only the reject scan: waiting 5s for a fill
        # that is not supposed to happen would freeze the ticket on every
        # placement.
        mine = lambda d: d.get("client_id") == client_id  # noqa: E731
        if pending:
            try:
                rej = c.wait_event("order.rejected", predicate=mine,
                                   timeout=0.5, since=mark)
                out["status"] = "rejected"
                out["reason"] = rej.get("reason")
            except TimeoutError:
                pass
            return out
        try:
            out["fill"] = c.wait_event("order.filled", predicate=mine,
                                       timeout=5.0, since=mark)
            out["status"] = "filled"
        except TimeoutError:
            try:
                rej = c.wait_event("order.rejected", predicate=mine,
                                   timeout=0.1, since=mark)
                out["status"] = "rejected"
                out["reason"] = rej.get("reason")
            except TimeoutError:
                pass
        return out

    def orders_list(self, broker: str) -> list[dict]:
        """Resting (working) orders, for the dock's Orders tab.

        Empty-not-error on brokers without resting orders: a market-only
        broker has nothing to list, and SPEC 3 says orders.list may be
        unanswerable (orders.can_list false), in which case the caller's
        order view is degraded rather than broken.
        """
        c = self._conn(broker)
        caps = (c.handshake.get("capabilities") or {}).get("orders") or {}
        if not caps.get("pending") or caps.get("can_list") is False:
            return []
        orders = c.request("orders.list", {"state": "resting"}).get("orders", [])
        # Belt and braces: some adapters answer state filters loosely, and a
        # filled/cancelled row painted as working would invite a cancel that
        # can only fail.
        return [o for o in orders if o.get("state") in (None, "resting")]

    def cancel_order(self, broker: str, order_id: str) -> dict:
        c = self._conn(broker)
        # client_id keyed on the order so a cancel retried after a dropped
        # response replays instead of erroring on the already-gone order
        # (same idempotency shape as position.close above).
        return c.request("order.cancel",
                         {"order_id": order_id,
                          "client_id": f"cancel-{order_id}-{uuid.uuid4().hex[:8]}"})

    def close_position(self, broker: str, position_id: str, qty=None) -> dict:
        c = self._conn(broker)
        # A client_id so a close retried after a dropped response is idempotent
        # (SPEC 2): the adapter returns the original outcome instead of closing
        # a second time. Keyed on the position and size so a deliberate later
        # close of the same position is a new request, not a swallowed replay.
        params = {"position_id": position_id,
                  "client_id": f"close-{position_id}-{qty or 'all'}-{uuid.uuid4().hex[:8]}"}
        if qty:
            params["qty"] = qty
        return c.request("position.close", params)

    def modify_position(self, broker: str, position_id: str,
                        sl=None, tp=None) -> dict:
        """SL/TP on an open position (SPEC `order.modify`).

        Callers pass the FULL desired bracket every time; None clears that
        side, exactly the sim engine's /sim/modify contract, so the chart's
        drag handles speak one language on both paths. Do not "optimise" to
        omit an unchanged side: omitted and null mean different things to the
        adapter, and a partial message would clear whichever side the caller
        thought it was leaving alone.
        """
        c = self._conn(broker)
        return c.request("order.modify",
                         {"position_id": position_id, "sl": sl, "tp": tp})

    def fills(self, broker: str, from_ms=None, to_ms=None) -> list[dict]:
        """The broker's own fill ledger (SPEC `history.fills`), for the
        account dock's History tab. Times are UTC epoch ms end to end; the
        window params pass through untranslated because inventing a local
        timezone here is how two terminals disagree about the same ledger.
        """
        c = self._conn(broker)
        params = {}
        if from_ms is not None:
            params["from"] = int(from_ms)
        if to_ms is not None:
            params["to"] = int(to_ms)
        return c.request("history.fills", params).get("fills", [])

    def shutdown(self):
        with self.lock:
            for b in list(self.conns) + list(self.pending_auth):
                self.disconnect(b)


# --- a connected broker, offered as a DATA source -------------------------
# Lives here rather than in providers/ because it is broker code: a thin
# window onto the hub above, holding no venue knowledge of its own.

_CATEGORY_LABELS = {
    "fx": "Forex", "forex": "Forex", "currency": "Forex",
    "crypto": "Crypto", "equity": "Equities", "stock": "Equities",
    "index": "Indices", "metal": "Metals", "commodity": "Commodities",
    "future": "Futures", "bond": "Bonds", "option": "Options",
}


def _category_label(raw) -> str:
    """A venue's asset_class as a display-ready folder name.

    The sidebar renders whatever a provider returns with no source-specific
    rules of its own (Provider.search's presentation contract), so the
    translation from a venue's vocabulary to a human label happens here.
    """
    key = str(raw or "").strip().lower()
    return _CATEGORY_LABELS.get(key) or key.replace("_", " ").title() or "Instruments"


class BrokerProvider(Provider):
    """A connected broker as the markets page's data source.

    When you execute on a venue, that venue's prices are the ones you should
    be looking at while you execute, so a connected broker can drive the
    watchlist and the chart.

    It deliberately does NOT drive backtests or research. A venue keeps a
    shallow slice of history next to the LSE archive, so letting the broker
    take those over would quietly shrink every backtest to whatever that venue
    happens to retain: the silent degradation this platform exists to refuse.
    The split is enforced by the caller (the markets page follows the active
    source, research asks for the data source), not by this class.

    Only offered for a broker that can actually serve candles. One whose
    handshake declares no bars/history (an order-entry-only FIX session)
    stays trade-only rather than becoming a data source with a permanently
    empty chart.
    """

    is_broker = True

    def __init__(self, hub, broker: str, label: str = "", timeframes=None):
        self.hub = hub
        self.broker = broker
        # Namespaced, so a venue can never collide with a data vendor's name
        # and the UI can tell the two apart from the name alone.
        self.name = f"broker:{broker}"
        self.title = label or broker
        if timeframes:
            self.timeframes = list(timeframes)

    def configured(self) -> bool:
        # A disconnected broker is not a source you can read; the picker greys
        # it rather than failing at the first candle request.
        return self.broker in self.hub.conns

    def search(self, query: str = "", limit: int = 50) -> list:
        rows = self.hub.catalog(self.broker)
        q = str(query or "").strip().upper()
        out = []
        for r in rows:
            sym = str(r.get("symbol") or "")
            name = str(r.get("name") or "")
            if q and q not in sym.upper() and q not in name.upper():
                continue
            out.append(Instrument(
                symbol=sym, name=name,
                category=_category_label(r.get("asset_class")),
                provider=self.name,
                # An untradable instrument still charts. The ticket decides
                # what may be dealt, and hiding these would make the venue
                # look smaller than it is.
                meta={"live": True, "tradable": bool(r.get("tradable", True))}))
        # Contiguous groups in a stable order: the sidebar renders arrival
        # order verbatim, one folder per category.
        out.sort(key=lambda i: (i.category, i.symbol))
        return out[:limit]

    def candles(self, symbol: str, timeframe: str, limit: int = 500,
                start=None, end=None):
        import pandas as pd  # noqa: PLC0415 - matches the other providers
        res = self.hub.connector(self.broker).request(
            "bars.history", {"symbol": symbol, "timeframe": timeframe,
                             "count": int(limit)})
        bars = res.get("bars") or []
        if not bars:
            return pd.DataFrame(columns=CANDLE_COLUMNS)
        df = pd.DataFrame([list(b[:6]) for b in bars], columns=CANDLE_COLUMNS)
        # The protocol speaks epoch MILLISECONDS; every provider hands the
        # chart epoch SECONDS. Getting this wrong puts the candles 55,000
        # years out rather than failing loudly, so it is done once, here.
        df["ts"] = pd.to_numeric(df["ts"], errors="coerce") // 1000
        for col in ("open", "high", "low", "close", "volume"):
            df[col] = pd.to_numeric(df[col], errors="coerce")
        df = df.dropna(subset=["ts", "open", "high", "low", "close"])
        if start is not None:
            df = df[df["ts"] >= int(start)]
        if end is not None:
            df = df[df["ts"] <= int(end)]
        return df[CANDLE_COLUMNS].sort_values("ts").reset_index(drop=True)

    def _board(self, symbols: list) -> dict:
        """Tell the venue what is on screen, then read the hub's live cache.

        Subscribing here rather than in the UI keeps this provider's contract
        identical to a vendor's: the caller asks for prices and the source
        arranges whatever it needs in order to answer.
        """
        try:
            self.hub.subscribe(self.broker, [s for s in symbols if s])
        except Exception:  # noqa: BLE001 - a broker with no quote stream
            pass           # still has whatever its last snapshot left behind
        return self.hub.latest_quotes(self.broker)

    def prices(self, symbols: list) -> list:
        cache = self._board(symbols)
        out = []
        for s in symbols:
            row = self._row(s, cache.get(s))
            if row is not None:
                out.append(row)
        return out

    @staticmethod
    def _row(symbol: str, q):
        if not q:
            return None
        bid, ask = q.get("bid"), q.get("ask")
        if bid is not None and ask is not None:
            price = (float(bid) + float(ask)) / 2.0
        elif bid is not None or ask is not None:
            price = float(bid if bid is not None else ask)
        else:
            return None
        return {"symbol": symbol, "price": price, "bid": bid, "ask": ask}

    def quote(self, symbol: str):
        row = self._row(symbol, self._board([symbol]).get(symbol))
        if row is None:
            raise NotSupported(f"{self.title} has no quote for {symbol}")
        return Quote(symbol=symbol, price=row["price"], ts=time.time(),
                     bid=row["bid"], ask=row["ask"])
