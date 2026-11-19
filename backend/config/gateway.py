"""Enforce the internal gateway boundary and keep API calls same-origin."""

from hmac import compare_digest
from ipaddress import ip_address
from urllib.parse import urlsplit

from django.conf import settings
from django.http import JsonResponse


PROBES = {"/api/health", "/api/ready"}


class GatewayAccessMiddleware:
    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        path = request.path_info
        if path != "/api" and not path.startswith("/api/"):
            return self.get_response(request)

        secret = settings.SPOTTER_GATEWAY_TOKEN
        if secret:
            try:
                address = ip_address(request.META.get("REMOTE_ADDR", ""))
            except ValueError:
                address = None
            local_probe = path in PROBES and address is not None and address.is_loopback
            if not local_probe:
                provided = request.META.get("HTTP_X_SPOTTER_GATEWAY_TOKEN", "")
                if not compare_digest(secret.encode(), provided.encode()):
                    return JsonResponse({"error": "API traffic must go through the gateway."}, status=403)
                try:
                    request.META["SPOTTER_CLIENT_IP"] = str(ip_address(request.META.get("HTTP_X_REAL_IP", "")))
                except ValueError:
                    return JsonResponse({"error": "Gateway client address is invalid."}, status=400)

        if request.META.get("HTTP_SEC_FETCH_SITE", "") in {"same-site", "cross-site"}:
            return JsonResponse({"error": "Use the API from the application's own origin."}, status=403)
        origin = request.META.get("HTTP_ORIGIN")
        if origin:
            host = request.get_host()
            try:
                parsed = urlsplit(origin)
                valid = (parsed.scheme == request.scheme and parsed.netloc.casefold() == host.casefold()
                         and not (parsed.username or parsed.password or parsed.path or parsed.query or parsed.fragment))
            except ValueError:
                valid = False
            if not valid:
                return JsonResponse({"error": "Use the API from the application's own origin."}, status=403)

        if request.method == "POST" and request.content_type != "application/json":
            return JsonResponse({"error": "Send the request body as application/json."}, status=415)
        return self.get_response(request)
