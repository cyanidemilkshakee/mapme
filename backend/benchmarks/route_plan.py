"""Measure planning through the first response and through playback without external services."""

import argparse
from datetime import datetime, timedelta, timezone
from functools import lru_cache
from gzip import compress
from hashlib import sha256
import json
from math import pi, sin
import os
from statistics import median
from time import perf_counter
from unittest.mock import patch

import django

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings")
django.setup()

from django.core.cache import cache
from django.test import override_settings
from rest_framework.test import APIRequestFactory

from routing import views
from routing.tests import TEST_CACHES


CASES = {
    "short": (1, 2, 400, 55, 55, 25),
    "medium": (3, 3, 1800, 110, 115, 10),
    "large": (5, 3, 5000, 750, 620, 10),
}


def fixture(name):
    legs, alternatives, vertices, miles, minutes, spacing = CASES[name]
    waypoints = [
        {"lat": 39, "lon": -120 + i * miles / 53, "label": f"Waypoint {i}", "country": "United States"}
        for i in range(legs + 1)
    ]
    options = []
    for index, (start, end) in enumerate(zip(waypoints, waypoints[1:])):
        choices = []
        for option in range(alternatives):
            distance = miles * (1 + option * 0.026) / views.MILES_PER_METER
            duration = (minutes + option * (4 + index)) * 60
            coordinates = []
            for vertex in range(vertices):
                fraction = vertex / (vertices - 1)
                longitude = start["lon"] + (end["lon"] - start["lon"]) * fraction
                latitude = 39 + (option - 0.6) * 0.21 * sin(pi * fraction) + 0.035 * sin(9 * pi * fraction)
                coordinates.append([round(longitude, 6), round(latitude, 6)])
            choices.append({
                "geometry": coordinates,
                "distance": distance,
                "duration": duration,
                "summary": f"Road {index + 1}.{option + 1}",
                "route_alternative": option + 1,
                "available_alternatives": alternatives,
                "annotation": {
                    "distance": [distance / (vertices - 1)] * (vertices - 1),
                    "duration": [duration / (vertices - 1)] * (vertices - 1),
                },
                "steps": [
                    {"name": f"Main Road {i}", "distance": distance / 15, "duration": duration / 15,
                     "maneuver": {"type": "turn", "modifier": "right"}}
                    for i in range(15)
                ],
            })
        options.append(choices)
    payload = {
        "origin_coordinates": waypoints[0],
        "stops": [{"coordinates": stop} for stop in waypoints[1:]],
        "requested_time": (datetime.now(timezone.utc) + timedelta(minutes=15)).isoformat(),
        "load_weight_lb": 38500,
        "checkpoint_interval_miles": spacing,
    }
    return payload, options


@lru_cache(maxsize=8)
def forecast_columns(start, end):
    hours = [hour * 3600 for hour in range(start, end + 1)]
    return [
        {
            "time": hours,
            "wind_speed_10m": [round(5 + (hour + bias) % 57 * 0.8, 1) for hour in range(start, end + 1)],
            "rain": [0.3 if (hour + bias) % 17 == 0 else 0.02 for hour in range(start, end + 1)],
            "snowfall": [0.8 if (hour + bias) % 29 == 0 else 0 for hour in range(start, end + 1)],
        } for bias in range(12)
    ]


def fake_forecast(points, window):
    columns = forecast_columns(*window)
    return [{
        "hourly": columns[(int(1000 * point["latitude"]) + int(1000 * point["longitude"])) % 12],
    } for point in points]


def benchmark(name, iterations, warm):
    payload, options = fixture(name)
    if warm:
        for index, choices in enumerate(options):
            for alternative, leg in enumerate(choices):
                leg["road_revision"] = sha256(f"{name}:{index}:{alternative}".encode()).hexdigest()
    request_factory = APIRequestFactory()
    timings = {}
    with (
        override_settings(CACHES=TEST_CACHES),
        patch.object(views, "MAX_FORECAST_POINTS", 1350),
        patch.object(views, "_get_leg_options", return_value=options),
        patch.object(views, "_fetch_forecast_chunk", side_effect=fake_forecast),
    ):
        for run in range(iterations + 1):
            cache.clear()
            request = request_factory.post("/api/route-plans?delivery=progressive", payload, format="json")
            started = perf_counter()
            response = views.plan_routes(request)
            if response.status_code != 200:
                raise RuntimeError(response.data)
            feed = iter(response.streaming_content)
            initial = next(feed)
            first = (perf_counter() - started) * 1000
            encoded = initial + b"".join(feed)
            total = (perf_counter() - started) * 1000
            response.close()
            if run == 0:
                continue
            stages = {
                name: float(stage) for name, stage in (
                    part.strip().split(";dur=") for part in response["Server-Timing"].split(",")
                )
            }
            for label, value in {**stages, "first_event": first, "through_playback": total}.items():
                timings.setdefault(label, []).append(value)
    return {
        "case": name,
        "prepared_geometry_cache": "warm" if warm else "cold",
        "median_ms": {label: round(median(values), 2) for label, values in timings.items()},
        "initial_gzip_bytes": len(compress(initial, compresslevel=1)),
        "total_gzip_bytes": len(compress(encoded, compresslevel=1)),
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--case", choices=CASES, action="append")
    parser.add_argument("--runs", type=int, default=7)
    parser.add_argument("--warm", action="store_true")
    args = parser.parse_args()
    if args.runs < 1:
        parser.error("--runs must be positive")
    for name in args.case or CASES:
        print(json.dumps(benchmark(name, args.runs, args.warm)), flush=True)
