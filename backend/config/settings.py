import os
import re
from pathlib import Path

from django.core.exceptions import ImproperlyConfigured
from django.core.management.utils import get_random_secret_key

BASE_DIR = Path(__file__).resolve().parent.parent

IS_VERCEL = os.environ.get("VERCEL", "").lower() == "1"
VERCEL_ENVIRONMENT = os.environ.get("VERCEL_ENV", "").lower()
PRODUCTION = (
    os.environ.get("DJANGO_ENVIRONMENT", "local").lower() == "production"
    or (IS_VERCEL and VERCEL_ENVIRONMENT in {"production", "preview"})
)
DEBUG = not PRODUCTION and os.environ.get("DJANGO_DEBUG", "true").lower() == "true"
SECRET_KEY = os.environ.get("DJANGO_SECRET_KEY") or ""
VERCEL_HOSTS = (
    os.environ.get(name, "").strip()
    for name in ("VERCEL_URL", "VERCEL_BRANCH_URL", "VERCEL_PROJECT_PRODUCTION_URL")
)
ALLOWED_HOSTS = list(dict.fromkeys([
    "localhost", "127.0.0.1", "[::1]",
    *(host for host in VERCEL_HOSTS if host),
    *(host.strip() for host in os.environ.get("DJANGO_ALLOWED_HOSTS", "").split(",") if host.strip()),
]))
# Vercel routes API requests through its public ingress, not the Kong gateway.
SPOTTER_GATEWAY_TOKEN = "" if IS_VERCEL else os.environ.get("SPOTTER_GATEWAY_TOKEN", "")
if ((PRODUCTION and not IS_VERCEL) or SPOTTER_GATEWAY_TOKEN) and not re.fullmatch(r"[A-Za-z0-9_-]{32,128}", SPOTTER_GATEWAY_TOKEN):
    raise ImproperlyConfigured("Set SPOTTER_GATEWAY_TOKEN to a random URL-safe secret of 32–128 characters.")

if PRODUCTION:
    if len(SECRET_KEY) < 50 or len(set(SECRET_KEY)) < 5 or SECRET_KEY.startswith("django-insecure-"):
        raise ImproperlyConfigured("Set DJANGO_SECRET_KEY to a strong random secret for production.")
    if "*" in ALLOWED_HOSTS:
        raise ImproperlyConfigured("List the public hosts explicitly in DJANGO_ALLOWED_HOSTS.")
    for name in ("GOOGLE_MAPS_API_KEY", "GOOGLE_MAPS_BROWSER_KEY"):
        if not os.environ.get(name, "").strip():
            raise ImproperlyConfigured(f"Set {name} for production.")
else:
    SECRET_KEY = SECRET_KEY or get_random_secret_key()

ENABLE_ADMIN = not PRODUCTION and os.environ.get("DJANGO_ENABLE_ADMIN", str(DEBUG)).lower() == "true"
SECURE_SSL_REDIRECT = PRODUCTION
SECURE_REDIRECT_EXEMPT = [r"^api/(?:health|ready)$"]
SESSION_COOKIE_SECURE = PRODUCTION
CSRF_COOKIE_SECURE = PRODUCTION
SECURE_HSTS_SECONDS = int(os.environ.get("DJANGO_HSTS_SECONDS", "31536000")) if PRODUCTION else 0
SECURE_HSTS_INCLUDE_SUBDOMAINS = PRODUCTION and os.environ.get("DJANGO_HSTS_SUBDOMAINS", "").lower() == "true"
SECURE_HSTS_PRELOAD = PRODUCTION and os.environ.get("DJANGO_HSTS_PRELOAD", "").lower() == "true"
if IS_VERCEL or SPOTTER_GATEWAY_TOKEN or os.environ.get("DJANGO_TRUST_PROXY_HTTPS", "").lower() == "true":
    SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https")

INSTALLED_APPS = [
    "rest_framework",
    "django.contrib.admin",
    "django.contrib.auth",
    "django.contrib.contenttypes",
    "django.contrib.sessions",
    "django.contrib.messages",
    "django.contrib.staticfiles",
    "routing.apps.RoutingConfig",
]

REST_FRAMEWORK = {
    "DEFAULT_AUTHENTICATION_CLASSES": [],
    "DEFAULT_PERMISSION_CLASSES": ["rest_framework.permissions.AllowAny"],
    "DEFAULT_RENDERER_CLASSES": ["rest_framework.renderers.JSONRenderer"],
    "DEFAULT_THROTTLE_CLASSES": ["routing.throttles.ApiThrottle"],
    "DEFAULT_THROTTLE_RATES": {
        "api": os.environ.get("API_REQUEST_RATE", "150/minute"),
        "plan": os.environ.get("API_PLAN_RATE", "15/minute"),
    },
    "NUM_PROXIES": int(os.environ.get("API_TRUSTED_PROXY_COUNT", "0")),
    "UNAUTHENTICATED_USER": None,
}

REDIS_URL = os.environ.get("REDIS_URL", "").strip()
DEFAULT_CACHE = (
    {
        "BACKEND": "django.core.cache.backends.redis.RedisCache",
        "LOCATION": REDIS_URL or "redis://127.0.0.1:6379/1",
        "OPTIONS": {"socket_connect_timeout": 0.5, "socket_timeout": 0.5},
    }
    if REDIS_URL or not IS_VERCEL
    else {
        "BACKEND": "django.core.cache.backends.locmem.LocMemCache",
        "LOCATION": "vercel-process-cache",
        "OPTIONS": {"MAX_ENTRIES": 5000},
    }
)

CACHES = {
    "default": DEFAULT_CACHE,
    "throttle_fallback": {
        "BACKEND": "django.core.cache.backends.locmem.LocMemCache",
        "LOCATION": "api-throttle-fallback",
        "OPTIONS": {"MAX_ENTRIES": 5000},
    },
}

MIDDLEWARE = [
    "config.gateway.GatewayAccessMiddleware",
    "django.middleware.security.SecurityMiddleware",
    "django.contrib.sessions.middleware.SessionMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.middleware.csrf.CsrfViewMiddleware",
    "django.contrib.auth.middleware.AuthenticationMiddleware",
    "django.contrib.messages.middleware.MessageMiddleware",
    "django.middleware.clickjacking.XFrameOptionsMiddleware",
]

ROOT_URLCONF = "config.urls"
DATA_UPLOAD_MAX_MEMORY_SIZE = 64 * 1024

TEMPLATES = [
    {
        "BACKEND": "django.template.backends.django.DjangoTemplates",
        "DIRS": [],
        "APP_DIRS": True,
        "OPTIONS": {
            "context_processors": [
                "django.template.context_processors.debug",
                "django.template.context_processors.request",
                "django.contrib.auth.context_processors.auth",
                "django.contrib.messages.context_processors.messages",
            ],
        },
    },
]

WSGI_APPLICATION = "config.wsgi.application"
ASGI_APPLICATION = "config.asgi.application"

DATABASES = {
    "default": {
        "ENGINE": "django.db.backends.sqlite3",
        "NAME": os.environ.get(
            "DJANGO_DATABASE_PATH",
            "/tmp/mapme.sqlite3" if IS_VERCEL else str(BASE_DIR / "db.sqlite3"),
        ),
    }
}

AUTH_PASSWORD_VALIDATORS = [
    {"NAME": "django.contrib.auth.password_validation.UserAttributeSimilarityValidator"},
    {"NAME": "django.contrib.auth.password_validation.MinimumLengthValidator"},
    {"NAME": "django.contrib.auth.password_validation.CommonPasswordValidator"},
    {"NAME": "django.contrib.auth.password_validation.NumericPasswordValidator"},
]

LANGUAGE_CODE = "en-us"
TIME_ZONE = "UTC"
USE_I18N = True
USE_TZ = True

STATIC_URL = "static/"
DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"
