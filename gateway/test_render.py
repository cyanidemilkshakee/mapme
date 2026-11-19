import unittest

from render import configuration


class GatewayConfigurationTests(unittest.TestCase):
    def test_local_api_methods_and_streaming(self):
        config = configuration({})
        api = config["services"][0]
        plans = api["routes"][0]
        self.assertEqual(plans["methods"], ["POST"])
        self.assertTrue(all(item["paths"][0].startswith("~/api") for item in api["routes"]))
        self.assertIn("route-plans|routes/plan", plans["paths"][0])
        self.assertFalse(plans["response_buffering"])
        limits = plans["plugins"][0]["config"]
        self.assertEqual((limits["minute"], limits["hour"]), (10, 90))
        self.assertEqual(limits["policy"], "redis")
        self.assertFalse(limits["fault_tolerant"])

    def test_production_requires_secret_private_auth_and_trusted_proxy(self):
        env = {"DJANGO_ENVIRONMENT": "production"}
        with self.assertRaisesRegex(ValueError, "SPOTTER_GATEWAY_TOKEN"):
            configuration(env)
        env["SPOTTER_GATEWAY_TOKEN"] = "aB0123456789_-abcdefABCDEFGHIJ123456"
        with self.assertRaisesRegex(ValueError, "requires a username"):
            configuration(env)
        config = configuration({
            **env,
            "SPOTTER_GATEWAY_USERNAME": "test",
            "SPOTTER_GATEWAY_PASSWORD": "fixture-auth-123456",
            "KONG_TRUSTED_IPS": "172.29.255.2",
        })
        self.assertIn("basic-auth", [plugin["name"] for plugin in config["plugins"]])
        for service in config["services"]:
            for route in service["routes"]:
                self.assertEqual(route["protocols"], ["http", "https"])
        self.assertIn("X-Spotter-Gateway-Token", config["services"][0]["plugins"][0]["config"]["remove"]["headers"])

    def test_rejects_open_proxy_trust(self):
        for value in ("0.0.0.0/0", "::/0", "not-an-ip"):
            with self.subTest(value=value), self.assertRaises(ValueError):
                configuration({"KONG_TRUSTED_IPS": value})


if __name__ == "__main__":
    unittest.main()
