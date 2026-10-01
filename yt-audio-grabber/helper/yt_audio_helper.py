#!/usr/bin/env python3
"""
YT Audio Grabber - local helper
Listens on 127.0.0.1 and drives yt-dlp to fetch the best original audio track.
Stdlib only. Python 3.8+.
"""
import json, os, re, secrets, shutil, subprocess, sys, threading, time, uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

APP_DIR = os.path.expanduser("~/.config/yt-audio-grabber")
TOKEN_FILE = os.path.join(APP_DIR, "token")
CONF_FILE = os.path.join(APP_DIR, "config.json")
DEFAULT_CONF = {
    "port": 8787,
    "output_dir": os.path.expanduser("~/Downloads"),
    "embed_thumbnail": True,
    "embed_metadata": True,
    "cookies_from_browser": "",     # e.g. "chrome" for age-restricted / members-only
    "filename_template": "%(title).150B [%(id)s].%(ext)s",
    "max_concurrent": 2,
}

JOBS = {}
JOBS_LOCK = threading.Lock()
SEM = None


def load_conf():
    os.makedirs(APP_DIR, exist_ok=True)
    conf = dict(DEFAULT_CONF)
    if os.path.exists(CONF_FILE):
        try:
            with open(CONF_FILE) as f:
                conf.update(json.load(f))
        except Exception as e:
            print("[warn] bad config.json: %s" % e, file=sys.stderr)
    with open(CONF_FILE, "w") as f:
        json.dump(conf, f, indent=2)
    conf["output_dir"] = os.path.expanduser(conf["output_dir"])
    os.makedirs(conf["output_dir"], exist_ok=True)
    return conf


def save_conf(conf, changed=None):
    """Write config back to disk.

    Re-read the file first and apply only the keys that actually changed, so a
    hand edit made while the service was running is not clobbered by our stale
    in-memory copy. Anything we did not touch keeps the on-disk value.
    """
    try:
        on_disk = {}
        if os.path.exists(CONF_FILE):
            try:
                with open(CONF_FILE) as f:
                    on_disk = json.load(f)
            except Exception:
                on_disk = {}
        merged = dict(DEFAULT_CONF)
        merged.update(on_disk)
        merged.update(changed if changed is not None else conf)
        with open(CONF_FILE, "w") as f:
            json.dump(merged, f, indent=2)
        # adopt any hand edit we just learned about for keys we did not change
        for k, v in merged.items():
            if changed is not None and k in changed:
                continue
            if k in conf and k != "port" and conf[k] != v:
                conf[k] = os.path.expanduser(v) if k == "output_dir" else v
        return True
    except OSError as e:
        print("[warn] cannot write config.json: %s" % e, file=sys.stderr)
        return False


def load_token():
    os.makedirs(APP_DIR, exist_ok=True)
    if os.path.exists(TOKEN_FILE):
        t = open(TOKEN_FILE).read().strip()
        if t:
            return t
    t = secrets.token_urlsafe(24)
    with open(TOKEN_FILE, "w") as f:
        f.write(t)
    os.chmod(TOKEN_FILE, 0o600)
    return t


def find_ytdlp():
    for c in ("yt-dlp", "yt-dlp_macos"):
        p = shutil.which(c)
        if p:
            return p
    for p in ("/opt/homebrew/bin/yt-dlp", "/usr/local/bin/yt-dlp",
              os.path.expanduser("~/.local/bin/yt-dlp")):
        if os.path.exists(p):
            return p
    return None


VIDEO_ID_RE = re.compile(r"(?:v=|/shorts/|youtu\.be/|/embed/|/live/)([A-Za-z0-9_-]{11})")
PROG_RE = re.compile(r"^__PROG__\|([^|]*)\|([^|]*)\|([^|]*)\|([^|]*)\|([^|]*)$")
# kept as a fallback in case --progress-template is ever unavailable
PROGRESS_RE = re.compile(r"\[download\]\s+(\d{1,3}(?:\.\d)?)%\s+of\s+~?\s*([0-9.]+\w+)(?:\s+at\s+([^\s]+))?(?:\s+ETA\s+([^\s]+))?")


def _num(v):
    """yt-dlp renders a missing field as 'NA'."""
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def human_bytes(n):
    if n is None:
        return ""
    for unit in ("B", "KiB", "MiB", "GiB"):
        if n < 1024 or unit == "GiB":
            return "%.1f%s" % (n, unit) if unit != "B" else "%dB" % n
        n /= 1024.0
    return ""


def human_eta(sec):
    if sec is None:
        return ""
    sec = int(sec)
    return "%d:%02d" % (sec // 60, sec % 60) if sec < 3600 else "%d:%02d:%02d" % (sec // 3600, sec % 3600 // 60, sec % 60)


def sanitize_url(raw):
    """Only allow youtube/youtu.be URLs."""
    u = urlparse(raw.strip())
    if u.scheme not in ("http", "https"):
        return None
    host = (u.hostname or "").lower()
    if host.startswith("www."):
        host = host[4:]
    allowed = ("youtube.com", "youtu.be", "music.youtube.com", "m.youtube.com",
               "youtube-nocookie.com")
    if host not in allowed and not host.endswith(".youtube.com"):
        return None
    return raw.strip()


def build_cmd(conf, ytdlp, url, fmt):
    out_tpl = os.path.join(conf["output_dir"], conf["filename_template"])
    cmd = [ytdlp, "--newline", "--no-colors", "--no-playlist",
           "--ignore-config", "--no-warnings",
           "-f", "bestaudio/best",
           "-x", "--audio-quality", "0",
           "-o", out_tpl,
           "--print", "after_move:__FINAL__%(filepath)s",
           "--no-simulate",
           # --print implies --quiet, which swallows every [download] line.
           # --progress forces progress output back on, and the templates below
           # give us raw numbers instead of a human-readable string to re-parse.
           "--progress",
           "--progress-template",
           "download:__PROG__|%(progress.downloaded_bytes)s|%(progress.total_bytes)s"
           "|%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s",
           "--progress-template", "postprocess:__POST__|%(progress.status)s"]
    # "original" keeps YouTube's native codec (opus/aac) with no re-encode
    if fmt in ("", "original", "best"):
        cmd += ["--audio-format", "best"]
    else:
        cmd += ["--audio-format", fmt]
        if fmt == "mp3":
            cmd += ["--postprocessor-args", "ffmpeg:-b:a 320k"]
    if conf.get("embed_metadata", True):
        cmd += ["--embed-metadata"]
    if conf.get("embed_thumbnail", True):
        cmd += ["--embed-thumbnail"]
    cb = (conf.get("cookies_from_browser") or "").strip()
    if cb:
        cmd += ["--cookies-from-browser", cb]
    cmd.append(url)
    return cmd


def run_job(job_id, conf, ytdlp, url, fmt):
    job = JOBS[job_id]
    with SEM:
        if job["status"] == "canceled":
            return
        job["status"] = "running"
        job["started_at"] = time.time()
        cmd = build_cmd(conf, ytdlp, url, fmt)
        job["cmd"] = " ".join(cmd)
        try:
            p = subprocess.Popen(cmd, stdout=subprocess.PIPE,
                                 stderr=subprocess.STDOUT,
                                 text=True, bufsize=1)
        except Exception as e:
            job["status"] = "error"
            job["error"] = str(e)
            return
        job["_proc"] = p
        tail = []
        for line in p.stdout:
            line = line.rstrip("\n")
            tail.append(line)
            if len(tail) > 40:
                tail.pop(0)
            job["log"] = tail[-6:]
            if line.startswith("__FINAL__"):
                job["file"] = line[len("__FINAL__"):]
                continue
            if line.startswith("__POST__"):
                job["stage"] = "processing"
                job["progress"] = max(job.get("progress", 0.0), 99.0)
                job["speed"] = ""
                job["eta"] = ""
                continue
            pm = PROG_RE.match(line)
            if pm:
                got, total, est, speed, eta = (_num(x) for x in pm.groups())
                denom = total or est
                if denom:
                    job["progress"] = max(0.0, min(100.0, got / denom * 100.0))
                    job["size"] = human_bytes(denom)
                elif got:
                    job["size"] = human_bytes(got)
                job["speed"] = (human_bytes(speed) + "/s") if speed else ""
                job["eta"] = human_eta(eta)
                job["stage"] = "downloading"
                continue
            m = PROGRESS_RE.search(line)
            if m:
                job["progress"] = float(m.group(1))
                job["size"] = m.group(2)
                job["speed"] = m.group(3) or ""
                job["eta"] = m.group(4) or ""
                job["stage"] = "downloading"
                continue
            if "[ExtractAudio]" in line or "[Merger]" in line:
                job["progress"] = max(job.get("progress", 0), 99.0)
                job["stage"] = "processing"
            if line.startswith("[youtube]") and "Downloading" not in line:
                pass
            tm = re.search(r"\[download\] Destination: (.+)$", line)
            if tm:
                job["file"] = tm.group(1)
            nm = re.search(r"^\[info\] (.+): Downloading", line)
            if nm:
                job["video_id"] = nm.group(1)
        rc = p.wait()
        job["_proc"] = None
        job["finished_at"] = time.time()
        if job["status"] == "canceled":
            return
        if rc == 0:
            job["status"] = "done"
            job["progress"] = 100.0
            if job.get("file"):
                job["title"] = os.path.basename(job["file"])
                try:
                    job["bytes"] = os.path.getsize(job["file"])
                except OSError:
                    pass
        else:
            job["status"] = "error"
            job["error"] = "\n".join(tail[-8:]) or ("yt-dlp exited %d" % rc)


class Handler(BaseHTTPRequestHandler):
    server_version = "YTAudioHelper/1.0"
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        sys.stderr.write("%s - %s\n" % (self.log_date_time_string(), fmt % args))

    # --- helpers -----------------------------------------------------
    def _origin_ok(self):
        o = self.headers.get("Origin", "")
        return (not o) or o.startswith("chrome-extension://") or o.startswith("moz-extension://")

    def _cors(self):
        o = self.headers.get("Origin", "")
        if o.startswith("chrome-extension://") or o.startswith("moz-extension://"):
            self.send_header("Access-Control-Allow-Origin", o)
            self.send_header("Vary", "Origin")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Auth-Token")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Max-Age", "600")

    def _json(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self._cors()
        self.end_headers()
        self.wfile.write(body)

    def _auth(self):
        if self.headers.get("X-Auth-Token", "") == self.server.token:
            return True
        self._json(401, {"error": "bad token"})
        return False

    # --- verbs -------------------------------------------------------
    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        if not self._origin_ok():
            return self._json(403, {"error": "forbidden origin"})
        u = urlparse(self.path)
        if u.path == "/health":
            return self._json(200, {
                "ok": True, "app": "yt-audio-grabber", "version": "1.0",
                "ytdlp": self.server.ytdlp,
                "ytdlp_version": self.server.ytdlp_version,
                "ffmpeg": bool(shutil.which("ffmpeg")),
                "output_dir": self.server.conf["output_dir"],
                "auth": self.headers.get("X-Auth-Token", "") == self.server.token,
            })
        if not self._auth():
            return
        if u.path == "/jobs":
            with JOBS_LOCK:
                out = [public(j) for j in JOBS.values()]
            out.sort(key=lambda j: j["created_at"], reverse=True)
            return self._json(200, {"jobs": out[:40]})
        if u.path == "/job":
            jid = (parse_qs(u.query).get("id") or [""])[0]
            j = JOBS.get(jid)
            if not j:
                return self._json(404, {"error": "no such job"})
            return self._json(200, public(j))
        if u.path == "/config":
            return self._json(200, self.server.conf)
        return self._json(404, {"error": "not found"})

    def do_POST(self):
        if not self._origin_ok():
            return self._json(403, {"error": "forbidden origin"})
        if not self._auth():
            return
        n = int(self.headers.get("Content-Length") or 0)
        try:
            data = json.loads(self.rfile.read(n) or b"{}")
        except Exception:
            return self._json(400, {"error": "bad json"})
        u = urlparse(self.path)

        if u.path == "/download":
            url = sanitize_url(data.get("url", ""))
            if not url:
                return self._json(400, {"error": "only YouTube URLs are accepted"})
            fmt = data.get("format", "original")
            if fmt not in ("original", "best", "m4a", "mp3", "opus", "flac", "wav"):
                return self._json(400, {"error": "bad format"})
            jid = uuid.uuid4().hex[:12]
            m = VIDEO_ID_RE.search(url)
            job = {"id": jid, "url": url, "format": fmt, "status": "queued",
                   "progress": 0.0, "created_at": time.time(),
                   "video_id": m.group(1) if m else "",
                   "title": data.get("title", ""), "log": []}
            with JOBS_LOCK:
                JOBS[jid] = job
            t = threading.Thread(target=run_job,
                                 args=(jid, self.server.conf, self.server.ytdlp, url, fmt),
                                 daemon=True)
            t.start()
            return self._json(200, public(job))

        if u.path == "/cancel":
            j = JOBS.get(data.get("id", ""))
            if not j:
                return self._json(404, {"error": "no such job"})
            j["status"] = "canceled"
            p = j.get("_proc")
            if p:
                try:
                    p.terminate()
                except Exception:
                    pass
            return self._json(200, public(j))

        if u.path == "/config":
            conf = self.server.conf
            changed = {}
            if "output_dir" in data:
                d = os.path.expanduser(str(data["output_dir"]).strip())
                if not d:
                    return self._json(400, {"error": "output_dir is empty"})
                try:
                    os.makedirs(d, exist_ok=True)
                except OSError as e:
                    return self._json(400, {"error": "cannot create %s: %s" % (d, e)})
                if not os.path.isdir(d) or not os.access(d, os.W_OK):
                    return self._json(400, {"error": "not a writable directory: %s" % d})
                conf["output_dir"] = d
                changed["output_dir"] = d
            for k in ("embed_thumbnail", "embed_metadata"):
                if k in data:
                    conf[k] = bool(data[k])
                    changed[k] = conf[k]
            if "cookies_from_browser" in data:
                v = str(data["cookies_from_browser"]).strip().lower()
                ok = ("", "chrome", "chromium", "brave", "edge", "firefox",
                      "safari", "vivaldi", "opera", "whale")
                if v not in ok:
                    return self._json(400, {"error": "cookies_from_browser must be one of: %s"
                                            % ", ".join(x or "(none)" for x in ok)})
                conf["cookies_from_browser"] = v
                changed["cookies_from_browser"] = v
            if "filename_template" in data:
                t = str(data["filename_template"]).strip()
                if not t or "/" in t:
                    return self._json(400, {"error": "filename_template must be a bare filename"})
                conf["filename_template"] = t
                changed["filename_template"] = t
            saved = save_conf(conf, changed)
            out = dict(conf)
            out["_saved"] = saved
            out["_changed"] = changed
            return self._json(200, out)

        if u.path == "/clear":
            with JOBS_LOCK:
                for k in [k for k, v in JOBS.items() if v["status"] in ("done", "error", "canceled")]:
                    del JOBS[k]
            return self._json(200, {"ok": True})

        return self._json(404, {"error": "not found"})


def public(j):
    return {k: v for k, v in j.items() if not k.startswith("_")}


def main():
    global SEM
    conf = load_conf()
    token = load_token()
    ytdlp = find_ytdlp()
    SEM = threading.Semaphore(int(conf.get("max_concurrent", 2)))
    ver = ""
    if ytdlp:
        try:
            ver = subprocess.run([ytdlp, "--version"], capture_output=True,
                                 text=True, timeout=15).stdout.strip()
        except Exception:
            pass
    srv = ThreadingHTTPServer(("127.0.0.1", int(conf["port"])), Handler)
    srv.token = token
    srv.conf = conf
    srv.ytdlp = ytdlp or ""
    srv.ytdlp_version = ver
    print("=" * 62)
    print(" YT Audio Grabber helper")
    print(" listening : http://127.0.0.1:%d" % conf["port"])
    print(" output    : %s" % conf["output_dir"])
    print(" yt-dlp    : %s (%s)" % (ytdlp or "NOT FOUND - run install.sh", ver))
    print(" ffmpeg    : %s" % (shutil.which("ffmpeg") or "NOT FOUND"))
    print("")
    print(" TOKEN (paste into the extension options page):")
    print("   %s" % token)
    print("=" * 62)
    sys.stdout.flush()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nbye")


if __name__ == "__main__":
    main()
