from datetime import datetime, timedelta, timezone
import os
from unittest.mock import patch

from django.test import SimpleTestCase, override_settings
from rest_framework.test import APIClient

from . import google_maps, views
from .route_delivery import encode_polyline


TEST_CACHES = {
    "default": {"BACKEND": "django.core.cache.backends.locmem.LocMemCache", "LOCATION": "routing-tests"},
    "throttle_fallback": {"BACKEND": "django.core.cache.backends.locmem.LocMemCache", "LOCATION": "routing-tests-fallback"},
}


def road_leg(start, end, middle_lat, minutes, alternative=1, alternatives=1, miles=50):
    distance = miles / views.MILES_PER_METER
    return {
        "geometry": [start, [(start[0] + end[0]) / 2, middle_lat], end],
        "distance": distance,
        "duration": minutes * 60,
        "route_alternative": alternative,
        "available_alternatives": alternatives,
        "annotation": {"distance": [distance / 2, distance / 2], "duration": [minutes * 54, minutes * 6]},
        "steps": [],
    }


def weather_response(points, window=None):
    start = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
    hours = [(start + timedelta(hours=hour)).strftime("%Y-%m-%dT%H:%M") for hour in range(7 * 24)]

    def weather_for(point):
        wind = 55 if point["latitude"] in (-0.1, 0.2) else 5
        return {"hourly": {
            "time": hours, "wind_speed_10m": [wind] * len(hours),
            "rain": [0] * len(hours), "snowfall": [0] * len(hours),
        }}

    return [weather_for(point) for point in points]



def google_route(path):
    # The test points use four or fewer decimal places. Scaling converts the
    # application's six-decimal encoder to Google's five-decimal input.
    polyline = encode_polyline([[lon / 10, lat / 10] for lon, lat in path])
    return {
        "distanceMeters": 1500, "duration": "100s", "polyline": {"encodedPolyline": polyline},
        "legs": [{"steps": [{
            "distanceMeters": 1500, "staticDuration": "100s", "polyline": {"encodedPolyline": polyline},
            "navigationInstruction": {"instructions": "Drive east"},
        }]}],
    }


def google_hour(timestamp, wind):
    return {
        "interval": {"startTime": timestamp.isoformat()},
        "wind": {"speed": {"unit": "MILES_PER_HOUR", "value": wind}},
        "precipitation": {"qpf": {"unit": "INCHES", "quantity": 0}},
    }

@override_settings(CACHES=TEST_CACHES)
class RoutingApiTests(SimpleTestCase):
    def setUp(self):
        self.client = APIClient()
        self.requested_time = datetime.now(timezone.utc) + timedelta(hours=3)
        self.start = {"lat": 0, "lon": 0, "country": "Test country", "label": "Starting point"}
        self.stop = {"lat": 0, "lon": 1, "country": "Test country", "label": "Stop"}
        self.end = {"lat": 0, "lon": 2, "country": "Test country", "label": "Destination"}
        self.payload = {
            "origin_coordinates": self.start,
            "stops": [{"coordinates": self.stop}, {"coordinates": self.end}],
            "requested_time": self.requested_time.isoformat(),
            "checkpoint_interval_miles": 25,
        }

    def plan(self, **overrides):
        return self.client.post("/api/route-plans", {**self.payload, **overrides}, format="json")

    def test_normalizes_current_precipitation_in_pin_and_heatmap(self):
        current = {"interval": 900, "wind_speed_10m": 10, "rain": 0.30, "snowfall": 0.15}
        with (
            patch.object(views, "_reverse_geocode", return_value={"address": {"country": "Test country"}}),
            patch.object(views, "_location_photos", return_value=[]),
            patch.object(views, "_current_weather", return_value={"current": current}),
            patch.object(views, "_fetch_ambient_heatmap", side_effect=lambda points: [{"current": current}] * len(points)),
        ):
            detail = self.client.get("/api/locations/details", {"lat": 38, "lon": -97}).json()
            heatmap = self.client.get("/api/weather/heatmap", {"south": 37, "west": -98, "north": 39, "east": -96}).json()

        self.assertEqual(detail["country"], "Test country")
        self.assertEqual(len(heatmap["points"]), heatmap["grid"]["rows"] * heatmap["grid"]["columns"])
        for sample in (detail, *heatmap["points"]):
            self.assertEqual(sample["rain_in_hr"], 1.2)
            self.assertEqual(sample["snow_in_hr"], 0.6)
            self.assertEqual(sample["risk"], "No Travel")

    def test_missing_current_weather_stays_unavailable(self):
        current = {"interval": 900, "wind_speed_10m": None, "rain": None, "snowfall": None}
        with (
            patch.object(views, "_reverse_geocode", return_value={}),
            patch.object(views, "_location_photos", return_value=[]),
            patch.object(views, "_current_weather", return_value={"current": current}),
        ):
            response = self.client.get("/api/locations/details", {"lat": 38, "lon": -97})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["risk"], "Unavailable")
        self.assertIsNone(response.json()["wind_mph"])

    def test_heatmap_preserves_current_temperature_independently_of_route_risk(self):
        current = views.google.current_weather({"temperature": {"degrees": 42, "unit": "CELSIUS"}})
        cold = views.google.current_weather({"temperature": {"degrees": -10, "unit": "FAHRENHEIT"}})
        samples = [current, cold, {"current": {"temperature_2m": float("nan")}}, *([{}] * 6)]
        with patch.object(views, "_fetch_ambient_heatmap", return_value=samples):
            response = self.client.get("/api/weather/heatmap", {"south": 20, "west": 75, "north": 24, "east": 79})

        self.assertEqual(response.status_code, 200)
        points = response.json()["points"]
        self.assertEqual(points[0]["risk"], "Unavailable")
        self.assertAlmostEqual(points[0]["temperature_f"], 107.6)
        self.assertEqual(points[1]["temperature_f"], -10)
        self.assertTrue(all(point["temperature_f"] is None for point in points[2:]))

    def test_heatmap_skips_weather_lookups_for_open_ocean_and_lake_views(self):
        for bounds in (
            {"south": -61, "west": -20, "north": -53, "east": -10},  # Southern Ocean
            {"south": 43.8, "west": -87.1, "north": 44.3, "east": -86.7},  # Lake Michigan
        ):
            with self.subTest(bounds=bounds), patch.object(views, "_fetch_ambient_heatmap") as fetch:
                response = self.client.get("/api/weather/heatmap", bounds)
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.json()["coverage"], "water")
                self.assertEqual(response.json()["points"], [])
                fetch.assert_not_called()

    def test_antarctic_coast_heatmap_masks_water_and_samples_only_land(self):
        with patch.object(views, "_fetch_ambient_heatmap", side_effect=lambda points: [
            {"current": {"temperature_2m": -42}} for _ in points
        ]) as fetch:
            response = self.client.get("/api/weather/heatmap", {"south": -77, "west": -75, "north": -63, "east": -52})

        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertEqual(data["coverage"], "mixed")
        self.assertTrue(data["land_mask"])
        land_points = fetch.call_args.args[0]
        self.assertGreater(len(land_points), 0)
        self.assertLess(len(land_points), len(data["points"]))
        self.assertTrue(all(point["surface"] == "land" and -77 < point["latitude"] < -63 for point in land_points))
        self.assertTrue(all(point["temperature_f"] == (-42 if point["surface"] == "land" else None) for point in data["points"]))

    def test_global_heatmap_masks_water_and_keeps_weather_lookups_bounded(self):
        with patch.object(views, "_fetch_ambient_heatmap", side_effect=lambda points: [
            {"current": {"temperature_2m": 60}} for _ in points
        ]) as fetch:
            response = self.client.get("/api/weather/heatmap", {"south": -85, "west": -180, "north": 85, "east": 180})
            panned = self.client.get("/api/weather/heatmap", {"south": -75, "west": -90, "north": 75, "east": 160})

        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertTrue(data["global_view"])
        self.assertEqual(data["coverage"], "mixed")
        self.assertTrue(data["land_mask"])
        land_points = fetch.call_args.args[0]
        self.assertGreater(len(land_points), 0)
        self.assertLessEqual(len(land_points), 25)
        self.assertTrue(all(point["surface"] == "land" for point in land_points))
        self.assertTrue(any(point["latitude"] < -80 for point in land_points))
        self.assertEqual(data["grid"], panned.json()["grid"])
        self.assertEqual(fetch.call_args_list[0].args, fetch.call_args_list[1].args)
        self.assertTrue(all(point["temperature_f"] == (60 if point["surface"] == "land" else None) for point in data["points"]))

    def test_selects_mixed_alternatives_and_uses_per_leg_timing(self):
        first = [road_leg([0, 0], [1, 0], 0.1, 90, 1, 2), road_leg([0, 0], [1, 0], -0.1, 75, 2, 2)]
        second = [road_leg([1, 0], [2, 0], 0.2, 10, 1, 2), road_leg([1, 0], [2, 0], -0.2, 20, 2, 2)]
        with (
            patch.object(views, "_get_leg_options", return_value=[first, second]),
            patch.object(views, "_fetch_forecast_chunk", side_effect=weather_response) as forecast,
        ):
            response = self.plan()
        self.assertEqual(response.status_code, 200, response.data)
        result = response.json()
        self.assertEqual(result["recommended_route_id"], "route-1")
        self.assertEqual(len(result["routes"]), 3)
        best = result["routes"][0]
        self.assertEqual([leg["route_alternative"] for leg in best["legs"]], [1, 2])
        checkpoint = next(point for point in best["checkpoints"] if point["distance_miles"] == 25)
        self.assertEqual(checkpoint["eta"], views._iso_utc(self.requested_time + timedelta(minutes=81)))
        stop_points = [point for point in best["checkpoints"] if point["distance_miles"] == 50]
        self.assertEqual({point["eta"] for point in stop_points}, {best["legs"][0]["arrival_time"]})
        self.assertEqual({point["leg_index"] for point in stop_points}, {0, 1})
        self.assertEqual(len(checkpoint["forecast"]), 49)
        self.assertEqual(forecast.call_count, 1)
        self.assertTrue(result["routes"][1]["metrics_by_hour"][0]["no_travel_checkpoints"])

    def test_short_trip_contains_both_endpoints_and_partial_forecast_disqualifies(self):
        leg = road_leg([0, 0], [0.002, 0], 0, 1, miles=0.15)
        with (
            patch.object(views, "_get_leg_options", return_value=[[leg]]),
            patch.object(views, "_fetch_forecast_chunk", side_effect=lambda points, window=None: [{}] * len(points)),
        ):
            response = self.plan(stops=[{"lat": 0, "lon": 0.002, "country": "Test country"}])
        self.assertEqual(response.status_code, 200, response.data)
        result = response.json()
        checkpoints = result["routes"][0]["checkpoints"]
        self.assertEqual([(point["distance_miles"], point["longitude"]) for point in checkpoints], [(0.0, 0), (0.15, 0.002)])
        self.assertIsNone(result["recommended_route_id"])
        self.assertEqual(result["routes"][0]["metrics_by_hour"][0]["unknown_checkpoints"], 2)

    def test_invalid_and_infeasible_trips_are_rejected_before_upstream_calls(self):
        before = datetime.now(timezone.utc) - timedelta(hours=1)
        with patch.object(views, "_get_leg_options") as routing:
            self.assertEqual(self.plan(stops=self.payload["stops"] * 3).status_code, 400)
            self.assertEqual(self.plan(requested_time="invalid").status_code, 400)
            self.assertEqual(self.plan(requested_time=before.isoformat()).status_code, 422)
            self.assertEqual(self.plan(requested_time=before.isoformat(), time_mode="arrival").status_code, 422)
            self.assertEqual(self.plan(stops=[{"lat": 0, "lon": 0}]).status_code, 400)
            routing.assert_not_called()

    def test_distinct_pins_with_the_same_latin_suffix_can_be_routed(self):
        self.assertFalse(views._same_waypoint(
            {**self.start, "label": "東京, Tokyo, Japan"},
            {**self.end, "label": "渋谷, Tokyo, Japan"},
        ))

    def test_google_routes_preserve_snap_and_reject_waypoints_far_from_road(self):
        snapped_path = [[0.0005, 0], [0.9995, 0]]
        route = google_route(snapped_path)
        with patch.object(views, "_get_json", return_value={"routes": [route, route]}) as upstream:
            [[leg]] = views._get_leg_options([self.start, self.stop])
        self.assertEqual(leg["geometry"], snapped_path)
        self.assertEqual(leg["steps"][0]["instruction"], "Drive east")
        self.assertEqual(leg["annotation"]["duration"], [100])
        self.assertTrue(upstream.call_args.kwargs["body"]["computeAlternativeRoutes"])
        self.assertEqual(upstream.call_args.args[0], google_maps.ROUTES_URL)
        with patch.object(views, "_get_json", return_value={"routes": [google_route([[0.02, 0], [1, 0]])]}):
            with self.assertRaises(views.TripInfeasibleError):
                views._get_leg_options([self.start, self.stop])

    def test_reports_nearby_outage_distinct_from_empty_results(self):
        with patch.object(views, "_get_json", side_effect=views.PlanningError("Provider offline")):
            response = self.client.get("/api/locations/nearby", {"category": "parking", "lat": 39, "lon": -97})
        self.assertEqual(response.status_code, 502)

    def test_plan_throttle_runs_before_more_provider_work(self):
        from django.core.cache import cache

        cache.clear()
        with patch.object(views, "_get_leg_options") as routing:
            for _ in range(15):
                self.assertEqual(self.plan(requested_time="invalid").status_code, 400)
            self.assertEqual(self.plan(requested_time="invalid").status_code, 429)
            routing.assert_not_called()
        cache.clear()

    def test_progressive_plan_preserves_rank_and_every_forecast_hour(self):
        first = [road_leg([0, 0], [1, 0], 0.1, 90, 1, 2), road_leg([0, 0], [1, 0], -0.1, 75, 2, 2)]
        second = [road_leg([1, 0], [2, 0], 0.2, 10, 1, 2), road_leg([1, 0], [2, 0], -0.2, 20, 2, 2)]
        from json import loads

        with (
            patch.object(views, "_get_leg_options", return_value=[first, second]),
            patch.object(views, "_fetch_forecast_chunk", side_effect=weather_response),
        ):
            full = self.plan().json()
            stream = self.client.post("/api/route-plans?delivery=progressive", self.payload, format="json")
            self.assertEqual(stream["X-Accel-Buffering"], "no")
            self.assertIn("rank;dur=", stream["Server-Timing"])
            initial, *updates = [loads(line) for line in stream.streaming_content]
        self.assertEqual(initial["type"], "plan")
        plan = initial["plan"]
        self.assertEqual(plan["recommended_route_id"], full["recommended_route_id"])
        self.assertEqual([route["id"] for route in plan["routes"]], [route["id"] for route in full["routes"]])
        self.assertIn("encoded_geometry", plan["routes"][0]["legs"][0])
        self.assertTrue(plan["routes"][1]["legs"][0]["geometry_pending"])
        for initial_route, full_route in zip(plan["routes"], full["routes"]):
            self.assertEqual(len(initial_route["checkpoints"]), len(full_route["checkpoints"]))
        self.assertEqual(len(plan["routes"][1]["preview_leg_weather"]), 2)
        self.assertEqual([event["type"] for event in updates], ["details"] * 3 + ["playback"] * 3)
        for route, first_render, details, playback in zip(full["routes"], plan["routes"], updates[:3], updates[3:]):
            self.assertEqual(first_render["metrics_by_hour"] + playback["metrics"], route["metrics_by_hour"])
            self.assertNotIn("checkpoints", details)
            points = first_render["checkpoints"]
            self.assertEqual(len(points), len(route["checkpoints"]))
            for original, initial_data, series in zip(route["checkpoints"], points, playback["series"]):
                self.assertEqual(initial_data["leg_index"], original["leg_index"])
                self.assertEqual(initial_data["distance_miles"], original["distance_miles"])
                self.assertEqual((initial_data["latitude"], initial_data["longitude"]), (original["latitude"], original["longitude"]))
                self.assertEqual(initial_data["eta"], original["eta"])
                self.assertEqual(initial_data["forecast"], original["forecast"][:1])
                for expected, packed in zip(original["forecast"][1:], series):
                    risk, wind, rain, snow, reasons = packed
                    self.assertEqual([risk, wind, rain, snow], [
                        expected["risk_index"], expected["wind_mph"], expected["rain_in_hr"], expected["snow_in_hr"],
                    ])
                    self.assertEqual([playback["reasons"][code] for code in reasons], expected["reasons"])

    def test_progressive_fetches_playback_coverage_after_the_initial_event(self):
        from json import loads

        option = road_leg([0, 0], [2, 0], 0, 80)
        payload = {**self.payload, "stops": [{"coordinates": self.end}]}
        with (
            patch.object(views, "_get_leg_options", return_value=[[option]]),
            patch.object(views, "_fetch_forecast_chunk", side_effect=weather_response) as lookup,
        ):
            response = self.client.post("/api/route-plans?delivery=progressive", payload, format="json")
            stream = iter(response.streaming_content)
            self.assertEqual(loads(next(stream))["type"], "plan")
            self.assertEqual(lookup.call_count, 1)
            self.assertEqual(loads(next(stream))["type"], "details")
            self.assertEqual(lookup.call_count, 1)
            self.assertEqual(loads(next(stream))["type"], "playback")
            self.assertEqual(lookup.call_count, 2)
        initial, playback = [call.kwargs["window"] for call in lookup.call_args_list]
        self.assertEqual(playback[1] - initial[1], views.PLAYBACK_HOURS - 1)

    def test_candidate_ranking_matches_exact_scan_in_both_time_modes(self):
        options = [
            [road_leg([index, 0], [index + 1, 0], latitude, 34.5 + minutes, alt + 1, 3, 50.15 + minutes / 100)
             for alt, (latitude, minutes) in enumerate(((0.1, 0), (0.2, 15), (-0.1, 7.4)))]
            for index in range(3)
        ]
        legs = [[views._prepare_leg(option, 10) for option in group] for group in options]
        def changing_weather(points):
            responses = weather_response(points)
            for index, response in enumerate(responses):
                response["hourly"]["wind_speed_10m"] = [
                    [5, 46, 55, None][(hour + index) % 4]
                    for hour in range(len(response["hourly"]["time"]))
                ]
            return responses

        with patch.object(views, "_fetch_forecast_chunk", side_effect=changing_weather):
            forecast, _ = views._route_weather(legs, 38500)
        for mode in ("departure", "arrival"):
            for minute in (0, 29, 30, 59):
                with self.subTest(mode=mode, minute=minute):
                    candidates, *_ = views._rank_trips(legs, self.requested_time.replace(minute=minute, second=58), mode)

                    def exact(candidate):
                        route, departure, duration = candidate
                        risks = ((point, forecast(point, (0,))[0]["risk"]) for point in views._trip_checkpoints(route, departure))
                        return views._rank_key(views._route_metrics(risks, duration))

                    self.assertEqual(views._rank_candidates(candidates, forecast), sorted(candidates, key=exact)[:3])

    def test_google_weather_reuses_active_forecast_and_fetches_missing_points(self):
        from .provider_cache import ProviderCache

        forecast_cache = ProviderCache("forecast-isolated-tests", 60, 10, 10000, lambda _: 64)
        first = {"latitude": 42, "longitude": -110}
        second = {"latitude": 43, "longitude": -109}
        third = {"latitude": 44, "longitude": -108}
        timestamp = datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0)

        def provider(_url, *, params, **_kwargs):
            return {"forecastHours": [google_hour(timestamp, params["location.latitude"])]}

        with (
            patch.object(views, "_FORECAST_CACHE", forecast_cache),
            patch.object(views, "_get_json", side_effect=provider) as api,
        ):
            one = views._fetch_forecast_chunk([first, second])
            two = views._fetch_forecast_chunk([second, third])
        self.assertEqual([item["hourly"]["wind_speed_10m"] for item in one], [[42], [43]])
        self.assertEqual([item["hourly"]["wind_speed_10m"] for item in two], [[43], [44]])
        self.assertEqual(api.call_count, 3)

    def test_google_weather_paginates_and_preserves_coverage_when_a_later_page_fails(self):
        from .provider_cache import ProviderCache

        forecast_cache = ProviderCache("forecast-partial-tests", 60, 10, 10000, lambda _: 64)
        point = {"latitude": 42, "longitude": -110}
        timestamp = datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0)
        hour = int(timestamp.timestamp()) // 3600
        observed = {"forecastHours": [google_hour(timestamp, 8)], "nextPageToken": "page-2"}

        with (
            patch.object(views, "_FORECAST_CACHE", forecast_cache),
            patch.object(views, "_get_json", side_effect=[observed, views.PlanningError("Offline")]) as api,
        ):
            result = views._fetch_forecast_chunk([point], (hour, hour + 48))
        self.assertEqual(result[0]["hourly"]["wind_speed_10m"], [8])
        self.assertEqual(api.call_args.kwargs["params"]["pageToken"], "page-2")

    def test_gaps_in_provider_hour_axis_do_not_shift_forecasts(self):
        start = int(self.requested_time.replace(minute=0, second=0, microsecond=0).timestamp())
        axis = views._forecast_axis((start, start + 7200))
        self.assertEqual(axis, (0, 0, {start // 3600: 0, start // 3600 + 2: 1}))

    def test_google_routes_are_requested_fresh_on_replan(self):
        with patch.object(views, "_get_json", return_value={"routes": [google_route([[0, 0], [1, 0]])]}) as request:
            self.assertEqual(views._get_leg_options([self.start, self.stop]), views._get_leg_options([self.start, self.stop]))
        self.assertEqual(request.call_count, 2)

    def test_maps_config_only_publishes_the_browser_key(self):
        with patch.dict(os.environ, {"GOOGLE_MAPS_BROWSER_KEY": "mock-browser", "GOOGLE_MAPS_API_KEY": "mock-server"}):
            reply = self.client.get("/api/maps/config")
        self.assertEqual(reply.json(), {"browserKey": "mock-browser"})
        self.assertEqual(reply["Cache-Control"], "no-store")

    def test_google_places_search_preserves_coordinates_and_attributions(self):
        data = {"places": [{
            "id": "place-123", "displayName": {"text": "Test cafe"}, "formattedAddress": "1 Main St",
            "location": {"latitude": 1, "longitude": 2},
            "addressComponents": [{"types": ["country"], "longText": "Example"}],
            "attributions": [{"provider": "Provider", "providerUri": "https://example.test"}],
        }]}
        with patch.object(views, "_get_json", return_value=data) as request:
            reply = self.client.get("/api/locations/search", {"q": "cafe", "near_lat": 1, "near_lon": 2})
        self.assertEqual(reply.json()["results"][0]["attributions"], [{"name": "Provider", "url": "https://example.test"}])
        self.assertEqual(request.call_args.kwargs["body"]["locationBias"]["circle"]["center"], {"latitude": 1, "longitude": 2})

    def test_google_weather_keeps_mixed_rain_unknown(self):
        sample = google_hour(datetime.now(timezone.utc), 30)
        sample["precipitation"] = {
            "qpf": {"unit": "INCHES", "quantity": 0.2},
            "snowQpf": {"unit": "INCHES", "quantity": 1.2},
            "probability": {"type": "RAIN_AND_SNOW"},
        }
        self.assertEqual(google_maps.weather_values(sample), (30, None, 1.2))

    def test_google_weather_handles_rain_types_and_ambiguous_precipitation(self):
        sample = google_hour(datetime.now(timezone.utc), 30)
        sample["precipitation"] = {
            "qpf": {"unit": "MILLIMETERS", "quantity": 12.7},
            "snowQpf": {"unit": "MILLIMETERS", "quantity": 0},
            "probability": {"type": "LIGHT_RAIN"},
        }
        for kind in ("RAIN", "LIGHT_RAIN", "HEAVY_RAIN"):
            with self.subTest(kind=kind):
                sample["precipitation"]["probability"]["type"] = kind
                self.assertEqual(google_maps.weather_values(sample), (30, 0.5, 0))
                self.assertEqual(views._classify_weather(*google_maps.weather_values(sample), 0, "Missing")[0], "Severe")
        sample["precipitation"]["probability"]["type"] = "NONE"
        self.assertEqual(google_maps.weather_values(sample), (30, None, 0))
        sample["precipitation"]["qpf"]["quantity"] = 0
        for kind in ("SLEET", "FREEZING_RAIN", "PRECIPITATION_TYPE_HAIL"):
            with self.subTest(kind=kind):
                sample["precipitation"]["probability"]["type"] = kind
                self.assertEqual(google_maps.weather_values(sample), (30, None, 0))

    def test_known_no_travel_is_not_hidden_by_missing_weather(self):
        risk, reasons = views._classify_weather(55, None, 0, 38500, "Rain unavailable")
        self.assertEqual(risk, "No Travel")
        self.assertIn("Rain unavailable", reasons)
        self.assertEqual(views._classify_weather(20, None, 0, 38500, "Rain unavailable")[0], "Unavailable")

    def test_eta_uses_the_hourly_interval_containing_arrival(self):
        start = self.requested_time.replace(minute=0, second=0, microsecond=0)
        point = {"latitude": 0, "longitude": 0}
        checkpoint = {**point, "eta": start + timedelta(minutes=59)}
        samples = [{"hourly": {
            "time": [int(start.timestamp()), int((start + timedelta(hours=1)).timestamp())],
            "wind_speed_10m": [5, 55], "rain": [0, 0], "snowfall": [0, 0],
        }}]
        with patch.object(views, "_fetch_forecast_chunk", return_value=samples):
            forecast, _ = views._route_weather([[{"checkpoints": [{"weather_key": (0, 0)}]}]], 38500)
        first, second = forecast(checkpoint, (0, 1))
        self.assertEqual((first["risk"], second["risk"]), ("Low", "No Travel"))
        self.assertEqual(first["time"], start.strftime("%Y-%m-%dT%H:%M:%SZ"))

