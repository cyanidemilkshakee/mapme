"""Build the DB-less Kong configuration from deployment settings."""

import ipaddress
import json
import os
from pathlib import Path
import re
import signal
import sys
from tempfile import NamedTemporaryFile


# The aliases share a counter because they belong to one Kong route.
API_ROUTES = (
    ("plans", r"~/api/(route-plans|routes/plan)$", ["POST"], 10, 90),
    ("search", r"~/api/locations/search$", ["GET"], 60, 600),
    ("place-details", r"~/api/locations/(nearby|details|photos)$", ["GET"], 30, 180),
    ("heatmap", r"~/api/weather/heatmap$", ["GET"], 30, 300),
    ("api-metadata", r"~/api/(health|ready|maps/config)$", ["GET", "HEAD"], 60, 600),
)
TOKEN = re.compile(r"[A-Za-z0-9_-]{32,128}")


def rate_plugin(minute, hour):
    return {"name": "rate-limiting", "config": {
        "minute": minute, "hour": hour, "limit_by": "ip",
        "policy": "redis", "redis": {"host": "gateway-redis", "port": 6379, "timeout": 500},
        "sync_rate": -1, "fault_tolerant": False, "hide_client_headers": False,
    }}


def configuration(env):
    production = env.get("DJANGO_ENVIRONMENT", "local").lower() == "production"
    access = env.get("SPOTTER_GATEWAY_ACCESS") or ("private" if production else "public")
    if access not in ("private", "public"):
        raise ValueError("SPOTTER_GATEWAY_ACCESS must be private or public.")
    if production and access != "private":
        raise ValueError("Production gateway access must be private.")

    trusted_proxies = []
    for value in env.get("KONG_TRUSTED_IPS", "").split(","):
        if not value.strip():
            continue
        try:
            cidr = ipaddress.ip_network(value.strip(), strict=False)
        except ValueError:
            raise ValueError("Set KONG_TRUSTED_IPS to the exact upstream proxy IPs or CIDRs.") from None
        if cidr.prefixlen == 0:
            raise ValueError("KONG_TRUSTED_IPS must not trust every client.")
        trusted_proxies.append(str(cidr))

    token = env.get("SPOTTER_GATEWAY_TOKEN", "")
    if (production or token) and not TOKEN.fullmatch(token):
        raise ValueError("SPOTTER_GATEWAY_TOKEN must contain 32–128 random URL-safe characters.")

    def route(name, path, methods, priority, buffering=True):
        return {
            "name": name, "paths": [path], "methods": methods,
            # TLS terminates at the private edge proxy; its forwarded scheme
            # is trusted only when its source address is in KONG_TRUSTED_IPS.
            "protocols": ["http", "https"],
            "regex_priority": priority, "strip_path": False, "preserve_host": True, "response_buffering": buffering,
        }

    api_routes = []
    for name, path, methods, minute, hour in API_ROUTES:
        entry = route(name, path, methods, 100, buffering=False)
        entry["plugins"] = [rate_plugin(minute, hour)]
        api_routes.append(entry)

    rejected_api = route("unknown-api", r"~/api(?:/|$)", None, 10)
    rejected_api.pop("methods")
    rejected_api["plugins"] = [{"name": "request-termination", "config": {"status_code": 404, "message": "API route not found."}}]
    api_routes.append(rejected_api)

    api_headers = {
        "remove": {"headers": [
            "Authorization", "Proxy-Authorization", "X-Spotter-Gateway-Token",
        ]},
    }
    if token:
        api_headers["add"] = {"headers": [f"X-Spotter-Gateway-Token:{token}"]}

    headers = [
        "X-Content-Type-Options:nosniff",
        "X-Frame-Options:DENY",
        "Referrer-Policy:strict-origin-when-cross-origin",
        "Permissions-Policy:geolocation=(self), camera=(), microphone=()",
        "Content-Security-Policy:base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'",
    ]
    if production:
        headers.append("Strict-Transport-Security:max-age=31536000")
    config = {
        "_format_version": "3.0",
        "_transform": True,
        "plugins": [{"name": "response-transformer", "config": {"add": {"headers": headers}}}],
        "services": [
            {
                "name": "spotter-api", "url": "http://backend:10002", "retries": 0,
                "connect_timeout": 3000, "read_timeout": 55000, "write_timeout": 10000,
                "routes": api_routes,
                "plugins": [
                    {"name": "request-transformer", "config": api_headers},
                    {"name": "request-size-limiting", "config": {"allowed_payload_size": 64, "size_unit": "kilobytes"}},
                ],
            },
            {
                "name": "spotter-web", "url": "http://frontend:80", "retries": 0,
                "connect_timeout": 3000, "read_timeout": 10000, "write_timeout": 5000,
                "routes": [route("web", "/", ["GET", "HEAD"], 0)],
            },
        ],
    }
    if access == "private":
        username = env.get("SPOTTER_GATEWAY_USERNAME", "")
        password = env.get("SPOTTER_GATEWAY_PASSWORD", "")
        if not re.fullmatch(r"[A-Za-z0-9_.@-]{1,64}", username) or len(password) < 16:
            raise ValueError("Private gateway access requires a username and a password of at least 16 characters.")
        config["consumers"] = [{"username": "spotter-operator", "basicauth_credentials": [
            {"username": username, "password": password},
        ]}]
        config["plugins"].append({"name": "basic-auth", "config": {"hide_credentials": True}})
    if production and not trusted_proxies:
        raise ValueError("Production requires KONG_TRUSTED_IPS for the HTTPS proxy.")
    return config


def write_config(path, config):
    path = Path(path)
    # The shared volume is mounted read-only by Kong. The browser credentials
    # and upstream token never enter the image or the renderer's output.
    with NamedTemporaryFile(mode="w", dir=path.parent, delete=False, encoding="utf-8") as handle:
        temporary = Path(handle.name)
        try:
            json.dump(config, handle)
            handle.flush()
            if os.getuid() == 0:
                os.chown(temporary, -1, 1337)
            os.chmod(temporary, 0o640)
            temporary.replace(path)
        finally:
            temporary.unlink(missing_ok=True)


if __name__ == "__main__":
    try:
        destination = Path(sys.argv[1])
        destination.unlink(missing_ok=True)
        write_config(destination, configuration(os.environ))
    except (OSError, ValueError) as exc:
        raise SystemExit(f"Kong configuration failed: {exc}") from None
    if sys.argv[2:] == ["--hold"]:
        # Docker's tmpfs-backed named volume stays mounted while this service
        # runs, including between rendering and Kong starting or restarting.
        signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
        while True:
            signal.pause()
