from functools import lru_cache
from hashlib import sha256
from uuid import uuid4

from django.conf import settings
from django.core.cache import caches
from redis import Redis
from redis.exceptions import RedisError
from rest_framework.throttling import SimpleRateThrottle


_SLIDING_WINDOW = """
local time = redis.call('TIME')
local now = time[1] * 1000000 + time[2]
local max_wait = 0
for i, key in ipairs(KEYS) do
    local limit = tonumber(ARGV[i * 2])
    local window = tonumber(ARGV[i * 2 + 1])
    redis.call('ZREMRANGEBYSCORE', key, '-inf', now - window)
    if redis.call('ZCARD', key) < limit then
        redis.call('ZADD', key, now, ARGV[1])
        redis.call('PEXPIRE', key, math.ceil(window / 1000))
    else
        local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
        max_wait = math.max(max_wait, tonumber(oldest[2]) + window - now)
    end
end
return max_wait
"""


@lru_cache(maxsize=4)
def _rate_script(url, connect_timeout, timeout):
    client = Redis.from_url(url, socket_connect_timeout=connect_timeout, socket_timeout=timeout)
    return client.register_script(_SLIDING_WINDOW)


class ApiThrottle(SimpleRateThrottle):
    scope = "api"

    def get_ident(self, request):
        return request.META.get("SPOTTER_CLIENT_IP") or super().get_ident(request)

    def get_cache_key(self, request, view):
        return self.cache_format % {"scope": self.scope, "ident": self.get_ident(request)}

    def _checks(self):
        return (self,)

    def allow_request(self, request, view):
        self.retry_after = None
        checks = self._checks()
        if any(check.rate and check.num_requests <= 0 for check in checks):
            return False
        config = settings.CACHES["default"]
        is_redis = config["BACKEND"] == "django.core.cache.backends.redis.RedisCache"
        location = config.get("LOCATION")
        if is_redis and isinstance(location, str) and not config.get("OPTIONS", {}).get("pool_class"):
            cached = config.get("OPTIONS", {})
            script = _rate_script(location, cached.get("socket_connect_timeout", 0.5), cached.get("socket_timeout", 0.5))
            key = sha256(str(self.get_ident(request)).encode()).hexdigest()
            keys = []
            args = [uuid4().hex]
            for check in checks:
                if check.rate:
                    keys.append(f"mapme:rate:{{{key}}}:{check.scope}")
                    args.extend((check.num_requests, check.duration * 1_000_000))
            if not keys:
                return True
            try:
                wait = script(keys=keys, args=args)
            except RedisError:
                pass
            else:
                self.retry_after = wait / 1_000_000 if wait else None
                return not wait

        denied = []
        for check in checks:
            if is_redis:
                check.cache = caches["throttle_fallback"]
            if not SimpleRateThrottle.allow_request(check, request, view):
                wait = SimpleRateThrottle.wait(check)
                if wait is not None:
                    denied.append(wait)
        self.retry_after = max(denied, default=None)
        return not denied

    def wait(self):
        return self.retry_after


class PlanThrottle(ApiThrottle):
    scope = "plan"

    def _checks(self):
        return ApiThrottle(), self
