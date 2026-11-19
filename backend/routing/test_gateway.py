from django.http import JsonResponse
from django.test import RequestFactory, SimpleTestCase, override_settings

from config.gateway import GatewayAccessMiddleware
from .throttles import ApiThrottle


@override_settings(
    ALLOWED_HOSTS=["spotter.example"],
    SPOTTER_GATEWAY_TOKEN="fixture-gateway-token-abcdef123456789",
    SECURE_PROXY_SSL_HEADER=("HTTP_X_FORWARDED_PROTO", "https"),
)
class GatewayAccessTests(SimpleTestCase):
    def setUp(self):
        self.factory = RequestFactory(HTTP_HOST="spotter.example", REMOTE_ADDR="10.20.30.40")
        self.headers = {
            "HTTP_X_SPOTTER_GATEWAY_TOKEN": "fixture-gateway-token-abcdef123456789",
            "HTTP_X_REAL_IP": "192.0.2.10",
            "HTTP_X_FORWARDED_PROTO": "https",
        }
        self.middleware = GatewayAccessMiddleware(lambda request: JsonResponse({"client": ApiThrottle().get_ident(request)}))

    def test_direct_requests_require_the_gateway_token(self):
        self.assertEqual(self.middleware(self.factory.get("/api/maps/config")).status_code, 403)
        self.assertEqual(self.middleware(self.factory.get("/api/ready")).status_code, 403)
        probe = self.factory.get("/api/ready", REMOTE_ADDR="127.0.0.1")
        self.assertEqual(self.middleware(probe).status_code, 200)

    def test_api_quota_uses_the_gateway_client_address(self):
        request = self.factory.get("/api/maps/config", **self.headers, HTTP_X_FORWARDED_FOR="198.51.100.20")
        self.assertEqual(self.middleware(request).content, b'{"client": "192.0.2.10"}')

    def test_cross_origin_and_non_json_requests_are_rejected(self):
        base = "/api/route-plans"
        valid = self.factory.post(base, "{}", content_type="application/json", HTTP_ORIGIN="https://spotter.example", **self.headers)
        self.assertEqual(self.middleware(valid).status_code, 200)
        cross_origin = self.factory.get("/api/locations/search", HTTP_ORIGIN="https://elsewhere.example", **self.headers)
        self.assertEqual(self.middleware(cross_origin).status_code, 403)
        cross_site = self.factory.get("/api/locations/search", HTTP_SEC_FETCH_SITE="same-site", **self.headers)
        self.assertEqual(self.middleware(cross_site).status_code, 403)
        form = self.factory.post(base, {"query": "location"}, **self.headers)
        self.assertEqual(self.middleware(form).status_code, 415)
