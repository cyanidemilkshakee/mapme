"""Bounded per-process cache in front of shared Redis provider results."""

from collections import OrderedDict
from concurrent.futures import Future
from hashlib import sha256
import json
import logging
from threading import Lock
from time import time

from django.core.cache import cache
from redis.exceptions import RedisError


logger = logging.getLogger(__name__)


class ProviderCache:
    def __init__(self, namespace, ttl, max_entries, max_bytes, size, *, shared=True):
        self.namespace = namespace
        self.ttl = ttl
        self.max_entries = max_entries
        self.max_bytes = max_bytes
        self.size = size
        self.shared = shared
        self.entries = OrderedDict()
        self.weight = 0
        self.pending = {}
        self.lock = Lock()

    def _shared_key(self, key):
        payload = json.dumps(key, ensure_ascii=False, separators=(",", ":"))
        return f"mapme:{self.namespace}:{sha256(payload.encode()).hexdigest()}"

    def _save_local(self, key, expires, value):
        size = self.size(value)
        with self.lock:
            previous = self.entries.pop(key, None)
            if previous:
                self.weight -= previous[2]
            if size > self.max_bytes:
                return
            while self.entries and (len(self.entries) >= self.max_entries or self.weight + size > self.max_bytes):
                _, (_, _, removed_size) = self.entries.popitem(last=False)
                self.weight -= removed_size
            self.entries[key] = expires, value, size
            self.weight += size

    def get_many(self, keys):
        hits = {}
        now = time()
        with self.lock:
            for key in keys:
                entry = self.entries.get(key)
                if entry is None:
                    continue
                if entry[0] > now:
                    self.entries.move_to_end(key)
                    hits[key] = entry[1]
                else:
                    del self.entries[key]
                    self.weight -= entry[2]

        if not self.shared:
            return hits
        shared_keys = {self._shared_key(key): key for key in keys if key not in hits}
        if not shared_keys:
            return hits
        try:
            shared = cache.get_many(shared_keys)
        except RedisError:
            return hits
        for shared_key, (expires, value) in shared.items():
            if expires > now:
                key = shared_keys[shared_key]
                self._save_local(key, expires, value)
                hits[key] = value
        return hits

    def set_many(self, values):
        expires = time() + self.ttl
        shared = {}
        for key, value in values.items():
            self._save_local(key, expires, value)
            if self.shared and self.size(value) <= min(self.max_bytes, 2 * 1024 * 1024):
                shared[self._shared_key(key)] = (expires, value)
        if shared:
            try:
                cache.set_many(shared, timeout=self.ttl)
            except RedisError:
                logger.debug("Shared provider cache unavailable", exc_info=True)

    def load_many(self, keys, load, remaining=None):
        """Share concurrent misses within a worker, including overlapping batches."""
        keys = tuple(dict.fromkeys(keys))
        hits = self.get_many(keys)
        owned = {}
        waiting = {}
        with self.lock:
            for key in keys:
                if key in hits:
                    continue
                entry = self.entries.get(key)
                if entry is not None and entry[0] > time():
                    self.entries.move_to_end(key)
                    hits[key] = entry[1]
                elif key in self.pending:
                    waiting[key] = self.pending[key]
                else:
                    future = Future()
                    self.pending[key] = owned[key] = future
        if owned:
            try:
                loaded = load(tuple(owned))
                self.set_many(loaded)
                hits.update(loaded)
                for key, future in owned.items():
                    future.set_result(loaded.get(key))
            except BaseException as exc:
                for future in owned.values():
                    future.set_exception(exc)
                raise
            finally:
                with self.lock:
                    for key in owned:
                        del self.pending[key]
        for key, future in waiting.items():
            value = future.result(timeout=remaining() if remaining else None)
            if value is not None:
                hits[key] = value
        return hits
