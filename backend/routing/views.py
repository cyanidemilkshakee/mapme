"""Route planning and location APIs backed by Google Maps Platform."""

from bisect import bisect_left, bisect_right
from concurrent.futures import ThreadPoolExecutor, as_completed
from contextvars import ContextVar, copy_context
from datetime import datetime, timedelta, timezone
from functools import lru_cache, wraps
from heapq import nsmallest
from itertools import accumulate, product
from math import asin, cos, isfinite, radians, sin, sqrt
import json
import logging
import os
import re
from threading import Lock
from time import monotonic, sleep
from urllib.parse import urlsplit

import httpx

from django.core.exceptions import RequestDataTooBig
from django.db import DatabaseError, connection
from django.http import StreamingHttpResponse
from rest_framework.decorators import api_view, throttle_classes
from rest_framework.exceptions import ParseError
from rest_framework.renderers import JSONRenderer
from rest_framework.response import Response

from . import google_maps as google
from .heatmap import MAX_GRID_SIDE, MASK_SIZE, heatmap_area
from .provider_cache import ProviderCache
from .route_delivery import encode_polyline

from .serializers import RoutePlanInputSerializer
from .throttles import PlanThrottle


MILES_PER_METER = 1 / 1609.344
FORECAST_DAYS = 7
PLAYBACK_HOURS = 49
HOUR_US = 3_600_000_000
EPOCH = datetime(1970, 1, 1, tzinfo=timezone.utc)
MAX_CHECKPOINTS_PER_ROUTE = 650
MAX_FORECAST_POINTS = max(9, min(300, int(os.environ.get("GOOGLE_WEATHER_MAX_POINTS", "120"))))
MAX_PROVIDER_RESPONSE_BYTES = 24 * 1024 * 1024
MAX_SNAP_METERS = 500
FORECAST_FIELDS = ("wind_speed_10m", "rain", "snowfall")
logger = logging.getLogger(__name__)
SUGGESTION_DISTANCE_BANDS_MILES = (10, 50, 250)
RISK_NAMES = ("Low", "Moderate", "High", "Severe", "No Travel", "Unavailable")
RISK_INDEX = {risk: index for index, risk in enumerate(RISK_NAMES)}
_PROVIDER_BUDGET = ContextVar("provider_budget", default=None)
_HTTP = httpx.Client(
    limits=httpx.Limits(max_connections=32, max_keepalive_connections=16, keepalive_expiry=30),
    headers={"User-Agent": "WeatherAwareTruckRouting/1.0"},
    follow_redirects=False,
)
_FORECAST_CACHE = ProviderCache(
    "google-forecast-v2", 10 * 60, 4096, 48 * 1024 * 1024,
    lambda value: 512 + 150 * len((value.get("hourly") or {}).get("time") or []),
)
_CURRENT_WEATHER_CACHE = ProviderCache("google-current-v2", 5 * 60, 2048, 4 * 1024 * 1024, lambda _: 2048)
_PREPARED_CACHE = ProviderCache(
    "prepared-v2", 15 * 60, 128, 16 * 1024 * 1024,
    lambda leg: len(leg["geometry"]) * 32 + len(leg["checkpoints"]) * 400,
    shared=False,
)
_ENCODED_ROAD_CACHE = ProviderCache(
    "encoded-roads-v2", 15 * 60, 128, 8 * 1024 * 1024, lambda value: len(value) + 32,
    shared=False,
)
NEARBY_TYPES = {
    "gas_stations": ["gas_station"],
    "restaurants": ["restaurant"],
    "train_stations": ["train_station", "subway_station"],
    "pharmacies": ["pharmacy"],
    "hotels": ["lodging"],
    "parking": ["parking"],
    "fast_food": ["fast_food_restaurant"],
    "cafes": ["cafe", "coffee_shop"],
}
WEATHER_JOBS = 12
_PLACE_ID = re.compile(r"^[A-Za-z0-9_-]{1,200}$")


def _country_key(value):
    return str(value or "").strip().casefold()


class PlanningError(Exception):
    pass


class TripValidationError(PlanningError):
    pass


class TripInfeasibleError(PlanningError):
    pass


class ProviderBudget:
    def __init__(self, seconds, calls):
        self.deadline = monotonic() + seconds
        self.calls = calls
        self.lock = Lock()

    def remaining(self):
        remaining = self.deadline - monotonic()
        if remaining <= 0:
            raise PlanningError("The planning services did not finish in time. Try again shortly.")
        return remaining

    def start_call(self):
        with self.lock:
            if self.calls <= 0:
                raise PlanningError("The request reached its planning service limit. Try again with fewer stops or wider checkpoint spacing.")
            self.calls -= 1


def provider_budget(seconds=16, calls=12):
    def decorate(view):
        @wraps(view)
        def bounded_view(*args, **kwargs):
            token = _PROVIDER_BUDGET.set(ProviderBudget(seconds, calls))
            try:
                return view(*args, **kwargs)
            finally:
                _PROVIDER_BUDGET.reset(token)

        return bounded_view

    return decorate


class ProviderExecutor(ThreadPoolExecutor):
    def submit(self, fn, /, *args, **kwargs):
        return super().submit(copy_context().run, fn, *args, **kwargs)


@api_view(["GET"])
@throttle_classes([])
def health_check(request):
    return Response({"status": "ok"})


@api_view(["GET"])
@throttle_classes([])
def readiness_check(request):
    try:
        with connection.cursor() as cursor:
            cursor.execute("SELECT 1")
    except DatabaseError:
        logger.exception("Readiness database check failed")
        return Response({"status": "unavailable"}, status=503)
    return Response({"status": "ready"})


def _remaining():
    budget = _PROVIDER_BUDGET.get()
    return budget.remaining() if budget else 16


def _get_json(url, *, timeout=8, fields="", params=None, body=None, retry=True):
    key = os.environ.get("GOOGLE_MAPS_API_KEY", "").strip()
    if not key:
        raise PlanningError("Google Maps Platform is not configured on the server. Set GOOGLE_MAPS_API_KEY.")
    headers = {"X-Goog-Api-Key": key}
    if fields:
        headers["X-Goog-FieldMask"] = fields
    host = urlsplit(url).hostname or "Google Maps Platform"
    budget = _PROVIDER_BUDGET.get()
    attempts = 2 if retry else 1
    for attempt in range(attempts):
        try:
            if budget:
                budget.start_call()
            request_timeout = min(timeout, _remaining())
            method = "POST" if body is not None else "GET"
            with _HTTP.stream(method, url, headers=headers, params=params, json=body,
                              timeout=httpx.Timeout(request_timeout, pool=min(1, request_timeout))) as response:
                status = response.status_code
                if status < 400:
                    content = bytearray()
                    for chunk in response.iter_bytes():
                        if budget:
                            budget.remaining()
                        if len(content) + len(chunk) > MAX_PROVIDER_RESPONSE_BYTES:
                            raise PlanningError(f"{host} returned too much data.")
                        content.extend(chunk)
                    return json.loads(content)
        except httpx.TimeoutException as exc:
            if attempt + 1 == attempts or _remaining() < 1:
                raise PlanningError(f"Connection to {host} timed out.") from exc
            logger.warning("Temporary timeout connecting to %s; retrying once.", host)
            sleep(0.25)
            continue
        except httpx.RequestError as exc:
            if attempt + 1 == attempts or _remaining() < 1:
                raise PlanningError(f"Could not connect to {host}.") from exc
            logger.warning("Temporary connection failure to %s (%s); retrying once.", host, type(exc).__name__)
            sleep(0.25)
            continue
        except (json.JSONDecodeError, UnicodeError) as exc:
            raise PlanningError(f"{host} returned an invalid JSON response.") from exc
        if status in (401, 403):
            raise PlanningError(f"{host} rejected the server credentials. Check key restrictions, API access, and billing.")
        if status not in (500, 502, 503, 504) or attempt + 1 == attempts:
            raise PlanningError(f"{host} returned HTTP {status}.")
        if _remaining() < 1:
            raise PlanningError(f"{host} returned HTTP {status}.")
        sleep(0.25)


@api_view(["GET"])
def maps_config(request):
    key = os.environ.get("GOOGLE_MAPS_BROWSER_KEY", "").strip()
    return Response({"browserKey": key}, headers={"Cache-Control": "no-store"})


def _parse_departure(value):
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except (AttributeError, ValueError) as exc:
        raise TripValidationError("Enter a valid trip date and time.") from exc
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    try:
        return parsed.astimezone(timezone.utc)
    except OverflowError as exc:
        raise TripValidationError("Enter a valid trip date and time.") from exc


def _geocode(query):
    results = _geocode_suggestions(query)
    if not results:
        raise TripInfeasibleError(f"No Google Maps result was found for {query}.")
    result = results[0]
    return {field: result[field] for field in ("lat", "lon", "label", "country")}


def _geocode_suggestions(query, near_lat=None, near_lon=None):
    body = {"textQuery": query, "pageSize": 8, "languageCode": "en"}
    if near_lat is not None and near_lon is not None:
        body["locationBias"] = {"circle": {"center": {"latitude": near_lat, "longitude": near_lon}, "radius": 50_000}}
    data = _get_json(f"{google.PLACES_URL}:searchText", body=body,
                     fields=",".join(f"places.{field}" for field in google.PLACES_FIELDS.split(",")))
    return [result for place in data.get("places", []) if (result := google.place_result(place)) is not None]


def _reverse_geocode(latitude, longitude):
    data = _get_json(
        f"{google.GEOCODE_URL}/location/{latitude},{longitude}",
        fields="results.placeId,results.formattedAddress,results.addressComponents,results.types",
    )
    results = data.get("results", [])
    if not results:
        return {}
    first = results[0]
    address = first.get("formattedAddress") or ""
    components = first.get("addressComponents", [])
    return {
        "name": address, "display_name": address, "place_id": first.get("placeId"),
        "address": {"country": google.country(components)},
    }


def _place_details(place_id, fields):
    return _get_json(f"{google.PLACES_URL}/{place_id}", fields=fields)


def _location_photos(place_id):
    if not place_id or not _PLACE_ID.fullmatch(place_id):
        return []
    response = _place_details(place_id, "photos")
    photos = []
    for photo in response.get("photos", [])[:2]:
        name = photo.get("name", "")
        if not re.fullmatch(r"places/[A-Za-z0-9_-]+/photos/[A-Za-z0-9_-]+", name):
            continue
        media = _get_json(
            f"https://places.googleapis.com/v1/{name}/media",
            params={"maxWidthPx": 640, "skipHttpRedirect": "true"}, retry=False,
        )
        url = media.get("photoUri", "")
        host = urlsplit(url).hostname or ""
        if not url.startswith("https://") or not (host.endswith(".googleusercontent.com") or host.endswith(".gstatic.com")):
            continue
        authors = [
            {"name": author["displayName"], "url": author.get("uri") or ""}
            for author in photo.get("authorAttributions", []) if author.get("displayName")
        ]
        photos.append({"url": url, "title": "Place photo", "authors": authors})
    return photos


@api_view(["GET"])
@provider_budget()
def search_locations(request):
    query = request.query_params.get("q", "").strip()
    if not query:
        return Response({"results": []})
    if len(query) > 500 or len(request.query_params.get("nearby_query", "")) > 500:
        return Response({"error": "Location queries must be at most 500 characters.", "results": []}, status=400)
    if len(query) < 2:
        return Response({"results": []})
    nearby_lat = nearby_lon = None
    try:
        nearby_lat = float(request.query_params.get("near_lat", ""))
        nearby_lon = float(request.query_params.get("near_lon", ""))
        if not isfinite(nearby_lat) or not isfinite(nearby_lon) or not (-90 <= nearby_lat <= 90) or not (-180 <= nearby_lon <= 180):
            nearby_lat = nearby_lon = None
    except (TypeError, ValueError):
        nearby_lat = nearby_lon = None
    if nearby_lat is None or nearby_lon is None:
        nearby_query = request.query_params.get("nearby_query", "").strip()
        if nearby_query:
            try:
                nearby = _geocode(nearby_query)
                nearby_lat, nearby_lon = nearby["lat"], nearby["lon"]
            except PlanningError:
                pass
    try:
        return Response({"results": _geocode_suggestions(query, nearby_lat, nearby_lon)}, headers={"Cache-Control": "no-store"})
    except PlanningError as exc:
        return Response({"error": str(exc), "results": []}, status=502)


def _nearby_places(category, latitude, longitude):
    data = _get_json(
        f"{google.PLACES_URL}:searchNearby",
        fields=",".join(f"places.{field}" for field in google.PLACES_FIELDS.split(",")),
        body={
            "includedTypes": NEARBY_TYPES[category], "maxResultCount": 12, "rankPreference": "DISTANCE",
            "locationRestriction": {"circle": {"center": {"latitude": latitude, "longitude": longitude}, "radius": 3500}},
        },
    )
    return [result for place in data.get("places", []) if (result := google.place_result(place)) is not None]


@api_view(["GET"])
@provider_budget()
def search_nearby(request):
    category = request.query_params.get("category", "")
    try:
        latitude = float(request.query_params["lat"])
        longitude = float(request.query_params["lon"])
    except (KeyError, TypeError, ValueError):
        return Response({"error": "Valid map coordinates are required.", "results": []}, status=400)
    if not (-90 <= latitude <= 90 and -180 <= longitude <= 180):
        return Response({"error": "Coordinates are outside valid map bounds.", "results": []}, status=400)
    if category not in NEARBY_TYPES:
        return Response({"error": "Choose a supported nearby category.", "results": []}, status=400)
    try:
        results = _nearby_places(category, round(latitude, 3), round(longitude, 3))
        return Response({"results": results, "category": category}, headers={"Cache-Control": "no-store"})
    except PlanningError as exc:
        return Response({"error": str(exc), "results": []}, status=502)


def _weather_query(latitude, longitude):
    return {"location.latitude": latitude, "location.longitude": longitude, "unitsSystem": "IMPERIAL"}


def _current_weather(latitude, longitude):
    key = (round(latitude, 4), round(longitude, 4))

    def load(keys):
        current = _get_json(
            f"{google.WEATHER_URL}/currentConditions:lookup", params=_weather_query(*keys[0]),
        )
        return {keys[0]: google.current_weather(current)}

    try:
        return _CURRENT_WEATHER_CACHE.load_many([key], load, _remaining)[key]
    except TimeoutError as exc:
        raise PlanningError("Current weather did not finish in time.") from exc


# Weather uses one request per point per page. A shared pool bounds provider concurrency
# across simultaneous maps and routes without serializing unrelated trip planning stages.
_WEATHER_EXECUTOR = ProviderExecutor(max_workers=WEATHER_JOBS)


def _point_weather(points, load):
    futures = {
        _WEATHER_EXECUTOR.submit(load, point["latitude"], point["longitude"]): index
        for index, point in enumerate(points)
    }
    results = [{} for _ in points]
    failures = []
    for future in as_completed(futures):
        try:
            results[futures[future]] = future.result()
        except (PlanningError, TimeoutError) as exc:
            failures.append(exc)
    if failures and not any(results):
        raise PlanningError(str(failures[0])) from failures[0]
    return results


def _fetch_ambient_heatmap(points):
    return _point_weather(points, _current_weather)


@api_view(["GET"])
@provider_budget()
def location_details(request):
    try:
        latitude = float(request.query_params["lat"])
        longitude = float(request.query_params["lon"])
        load_weight = float(request.query_params.get("load_weight_lb", 0))
    except (KeyError, TypeError, ValueError):
        return Response({"error": "Valid latitude and longitude are required."}, status=400)
    if not (-90 <= latitude <= 90 and -180 <= longitude <= 180):
        return Response({"error": "Coordinates are outside valid map bounds."}, status=400)
    if not 0 <= load_weight <= 200000:
        return Response({"error": "Load weight must be between 0 and 200,000 lb."}, status=400)

    location_name = "Unknown location"
    address = ""
    photos = []
    website = phone = opening_hours = category = country = None
    attributions = []
    place_id = request.query_params.get("place_id", "")
    if place_id and not _PLACE_ID.fullmatch(place_id):
        return Response({"error": "Invalid Google Place ID."}, status=400)
    reverse_error = weather_error = None
    with ProviderExecutor(max_workers=2) as executor:
        weather_future = executor.submit(_current_weather, latitude, longitude)
        try:
            if place_id:
                response = _place_details(
                    place_id, google.PLACES_FIELDS + ",websiteUri,nationalPhoneNumber,regularOpeningHours.weekdayDescriptions"
                )
                place = google.place_result(response) or {}
                location_name = place.get("name") or location_name
                address = place.get("address") or ""
                country = place.get("country")
                category = place.get("category")
                attributions = place.get("attributions", [])
                website = response.get("websiteUri")
                phone = response.get("nationalPhoneNumber")
                opening_hours = " • ".join((response.get("regularOpeningHours") or {}).get("weekdayDescriptions", [])) or None
            else:
                reverse = _reverse_geocode(round(latitude, 5), round(longitude, 5))
                location_name = reverse.get("name") or f"Location near {latitude:.5f}, {longitude:.5f}"
                address = reverse.get("display_name") or ""
                country = (reverse.get("address") or {}).get("country")
                place_id = reverse.get("place_id") or ""
        except PlanningError as exc:
            reverse_error = str(exc)
            location_name = f"Location near {latitude:.5f}, {longitude:.5f}"
        if place_id and request.query_params.get("photos", "1") != "0":
            try:
                photos = _location_photos(place_id)
            except PlanningError:
                pass

        try:
            current = weather_future.result().get("current") or {}
        except PlanningError as exc:
            current = {}
            weather_error = str(exc)

    wind, rain, snow = _current_weather_rates(current)
    risk, reasons = _classify_weather(
        wind, rain, snow, load_weight, weather_error or "Current weather data is incomplete.",
    )
    return Response({
        "latitude": latitude,
        "longitude": longitude,
        "location_name": location_name,
        "address": address or location_name,
        "country": country,
        "place_id": place_id or None,
        "attributions": attributions,
        "photos": photos,
        "category": category,
        "website": website,
        "phone": phone,
        "opening_hours": opening_hours,
        "location_error": reverse_error,
        "observed_at": current.get("time"),
        "condition": current.get("condition"),
        "temperature_f": current.get("temperature_2m"),
        "feels_like_f": current.get("apparent_temperature"),
        "humidity_percent": current.get("relative_humidity_2m"),
        "wind_mph": round(wind, 1) if wind is not None else None,
        "gust_mph": current.get("wind_gusts_10m"),
        "rain_in_hr": round(rain, 2) if rain is not None else None,
        "snow_in_hr": round(snow, 2) if snow is not None else None,
        "risk": risk,
        "risk_reasons": reasons,
        "load_weight_lb": load_weight,
    }, headers={"Cache-Control": "no-store"})


@api_view(["GET"])
@provider_budget(seconds=10, calls=6)
def location_photos(request):
    place_id = request.query_params.get("place_id", "")
    if place_id and not _PLACE_ID.fullmatch(place_id):
        return Response({"error": "Invalid Google Place ID."}, status=400)
    if not place_id:
        try:
            latitude, longitude = float(request.query_params["lat"]), float(request.query_params["lon"])
        except (KeyError, TypeError, ValueError):
            return Response({"error": "Provide a Google Place ID or valid coordinates."}, status=400)
        if not (-90 <= latitude <= 90 and -180 <= longitude <= 180):
            return Response({"error": "Coordinates are outside valid map bounds."}, status=400)
    try:
        if not place_id:
            place_id = _reverse_geocode(round(latitude, 5), round(longitude, 5)).get("place_id")
        return Response({"photos": _location_photos(place_id)}, headers={"Cache-Control": "no-store"})
    except (PlanningError, TimeoutError) as exc:
        return Response({"error": str(exc), "photos": []}, status=502)


def _coordinates_from_payload(value, label):
    if not isinstance(value, dict):
        raise TripValidationError("Waypoint coordinates are invalid.")
    try:
        latitude = float(value["lat"])
        longitude = float(value["lon"])
    except (KeyError, TypeError, ValueError) as exc:
        raise TripValidationError("Waypoint coordinates are invalid.") from exc
    if not (-90 <= latitude <= 90 and -180 <= longitude <= 180):
        raise TripValidationError("Waypoint coordinates are outside valid map bounds.")
    return {
        "lat": latitude,
        "lon": longitude,
        "label": str(value.get("label") or label or "My location").strip(),
        "country": str(value.get("country") or "").strip() or None,
    }


def _country_for_waypoint(waypoint):
    country = str(waypoint.get("country") or "").strip()
    if country:
        return country
    try:
        reverse = _reverse_geocode(round(waypoint["lat"], 5), round(waypoint["lon"], 5))
    except (PlanningError, KeyError, TypeError, ValueError):
        return None
    return str((reverse.get("address") or {}).get("country") or "").strip() or None


def _distance_miles(a, b):
    lat1, lon1 = radians(a["lat"]), radians(a["lon"])
    lat2, lon2 = radians(b["lat"]), radians(b["lon"])
    dlat, dlon = lat2 - lat1, lon2 - lon1
    hav = sin(dlat / 2) ** 2 + cos(lat1) * cos(lat2) * sin(dlon / 2) ** 2
    return 3958.7613 * 2 * asin(sqrt(min(1, max(0, hav))))


def _same_waypoint(first, second):
    return _distance_miles(first, second) <= 0.02


def _route_signature(route):
    coords = route["geometry"]
    if not coords:
        return ()
    last_index = len(coords) - 1
    sample_count = min(21, len(coords))
    samples = {
        round(sample * last_index / (sample_count - 1))
        for sample in range(sample_count)
    } if sample_count > 1 else {0}
    return tuple((round(coords[index][0], 4), round(coords[index][1], 4)) for index in sorted(samples))


def _get_leg_options(waypoints):
    def fetch_segment(start, end):
        data = _get_json(google.ROUTES_URL, body=google.route_request(start, end), fields=google.ROUTE_FIELDS)
        if not data.get("routes"):
            raise TripInfeasibleError(
                f"No Google driving route was found near {start['label']} and {end['label']}."
            )
        options = []
        signatures = set()
        too_far = False
        for raw in data["routes"]:
            leg = google.road_option(raw)
            if not leg:
                continue
            endpoints = [leg["geometry"][0], leg["geometry"][-1]]
            if any(_distance_miles(waypoint, {"lat": lat, "lon": lon}) > MAX_SNAP_METERS * MILES_PER_METER
                   for waypoint, (lon, lat) in zip((start, end), endpoints)):
                too_far = True
                continue
            signature = _route_signature(leg)
            if signature in signatures:
                continue
            signatures.add(signature)
            options.append({**leg, "route_alternative": len(options) + 1})
            if len(options) == 3:
                break
        if not options:
            if too_far:
                raise TripInfeasibleError("A waypoint is too far from the routing network. Choose a point closer to a road.")
            raise PlanningError("Google Maps did not return usable road geometry.")
        for option in options:
            option["available_alternatives"] = len(options)
        return options

    segments = list(zip(waypoints, waypoints[1:]))
    with ProviderExecutor(max_workers=min(3, len(segments))) as executor:
        futures = [executor.submit(fetch_segment, start, end) for start, end in segments]
        return [future.result() for future in futures]


def _geometry_lengths(coordinates):
    vertices = iter(coordinates)
    previous_lon, previous_lat = map(radians, next(vertices))
    previous_cos = cos(previous_lat)
    cumulative = [0.0]
    for longitude, latitude in vertices:
        lon, lat = radians(longitude), radians(latitude)
        latitude_cos = cos(lat)
        haversine = sin((lat - previous_lat) / 2) ** 2
        haversine += previous_cos * latitude_cos * sin((lon - previous_lon) / 2) ** 2
        distance = 3958.7613 * 2 * asin(sqrt(min(1, max(0, haversine))))
        cumulative.append(cumulative[-1] + distance)
        previous_lon, previous_lat, previous_cos = lon, lat, latitude_cos
    return cumulative


def _segment_fraction(cumulative, distance):
    segment = min(len(cumulative) - 2, max(0, bisect_right(cumulative, distance) - 1))
    length = cumulative[segment + 1] - cumulative[segment]
    return segment, min(1, max(0, (distance - cumulative[segment]) / length)) if length else 0


def _point_at_distance(coordinates, segment, fraction):
    (lon, lat), (next_lon, next_lat) = coordinates[segment:segment + 2]
    longitude_delta = (next_lon - lon + 180) % 360 - 180
    return lat + (next_lat - lat) * fraction, (lon + longitude_delta * fraction + 180) % 360 - 180


def _compass_direction(bearing):
    directions = ("north", "northeast", "east", "southeast", "south", "southwest", "west", "northwest")
    return directions[int((float(bearing) % 360 + 22.5) // 45) % 8]


def _route_instruction(step, arrival_label=None):
    maneuver = step.get("maneuver") or {}
    maneuver_type = str(maneuver.get("type") or "continue").replace("_", " ").lower()
    modifier = str(maneuver.get("modifier") or "").replace("_", " ").lower()
    road = str(step.get("name") or step.get("ref") or "").strip()
    onto_road = f" onto {road}" if road else ""

    if maneuver_type == "arrive":
        return f"Arrive at {arrival_label}" if arrival_label else "Arrive at the next stop"
    if maneuver_type == "depart":
        bearing = maneuver.get("bearing_after")
        heading = f" {_compass_direction(bearing)}" if bearing is not None else ""
        return f"Head{heading} on {road}" if road else f"Head{heading} toward your destination"
    if maneuver_type in ("roundabout", "rotary"):
        exit_number = maneuver.get("exit")
        exit_text = f" exit {exit_number}" if exit_number else " the exit"
        return f"At the {maneuver_type}, take{exit_text}{onto_road}"
    if maneuver_type in ("exit roundabout", "exit rotary"):
        return f"Exit the {maneuver_type.replace('exit ', '')}{onto_road}"
    if maneuver_type == "uturn":
        return f"Make a U-turn{onto_road}"
    if maneuver_type == "end of road":
        turn = f" and turn {modifier}" if modifier else " and turn"
        return f"At the end of the road{turn}{onto_road}"
    if maneuver_type == "fork":
        direction = f" {modifier}" if modifier else ""
        return f"Keep{direction} at the fork{onto_road}"
    if maneuver_type in ("on ramp", "off ramp"):
        action = "Take the ramp" if maneuver_type == "on ramp" else "Take the exit"
        direction = f" {modifier}" if modifier else ""
        return f"{action}{direction}{onto_road}"
    if maneuver_type == "merge":
        direction = f" {modifier}" if modifier else ""
        return f"Merge{direction}{onto_road or ' onto the road'}"
    if maneuver_type in ("turn", "new name", "continue", "notification", "use lane"):
        if maneuver_type == "turn":
            action = f"Turn {modifier}" if modifier else "Turn"
        elif maneuver_type == "use lane":
            action = f"Use the {modifier} lane" if modifier else "Use the indicated lane"
        elif maneuver_type == "continue" and modifier and modifier != "straight":
            action = f"Continue {modifier}"
        else:
            action = "Continue straight" if modifier == "straight" else "Continue"
        connector = " onto " if road else ""
        return f"{action}{connector}{road}" if road else action
    direction = f" {modifier}" if modifier else ""
    return f"Continue{direction}{onto_road}"


def _prepare_leg(leg, interval, *, compact=False):
    if "road_revision" not in leg:
        return _prepare_leg_uncached(leg, interval, compact)
    key = (leg["road_revision"], interval, compact)
    return _PREPARED_CACHE.load_many([key], lambda _: {key: _prepare_leg_uncached(leg, interval, compact)})[key]


def _annotation_prefix(values, segment_count):
    if not isinstance(values, list) or len(values) != segment_count:
        return None
    clean = [_nonnegative_number(value) for value in values]
    if None in clean:
        return None
    prefix = list(accumulate(clean, initial=0.0))
    return prefix if prefix[-1] else None


def _prepare_leg_uncached(leg, interval, compact):
    coordinates = leg["geometry"]
    segment_count = len(coordinates) - 1
    road_miles = leg["distance"] * MILES_PER_METER
    annotation = leg.get("annotation") or {}
    road_distances = _annotation_prefix(annotation.get("distance"), segment_count)
    segment_times = _annotation_prefix(annotation.get("duration"), segment_count)
    geometry_distances = None
    if not compact or road_distances is None:
        geometry_distances = _geometry_lengths(coordinates)
        if not geometry_distances[-1]:
            raise PlanningError("The routing service returned an empty road path.")
        if road_distances is None:
            road_distances = geometry_distances
    elif all(point == coordinates[0] for point in coordinates[1:]):
        raise PlanningError("The routing service returned an empty road path.")

    checkpoints = []
    distance = 0.0
    while distance < road_miles:
        if len(checkpoints) >= MAX_CHECKPOINTS_PER_ROUTE:
            raise TripInfeasibleError("This trip needs too many checkpoints. Increase the spacing or plan a shorter trip.")
        segment, fraction = _segment_fraction(road_distances, road_distances[-1] * distance / road_miles)
        if distance:
            latitude, longitude = _point_at_distance(coordinates, segment, fraction)
        else:
            longitude, latitude = coordinates[0]
        geometry_fraction = 0
        if geometry_distances and distance:
            before, after = geometry_distances[segment:segment + 2]
            geometry_fraction = (before + (after - before) * fraction) / geometry_distances[-1]
        time_fraction = distance / road_miles
        if segment_times and distance:
            before, after = segment_times[segment:segment + 2]
            time_fraction = (before + (after - before) * fraction) / segment_times[-1]
        checkpoints.append({
            "distance_miles": distance,
            "geometry_fraction": geometry_fraction,
            "segment_position": segment + fraction if distance else 0,
            "latitude": latitude,
            "longitude": longitude,
            "elapsed_seconds": leg["duration"] * time_fraction,
        })
        distance += interval
    checkpoints.append({
        "distance_miles": road_miles,
        "geometry_fraction": 1,
        "segment_position": segment_count,
        "latitude": coordinates[-1][1],
        "longitude": coordinates[-1][0],
        "elapsed_seconds": leg["duration"],
    })
    for first, second in zip(checkpoints, checkpoints[1:]):
        first["miles_to_next"] = second["distance_miles"] - first["distance_miles"]
    checkpoints[-1]["miles_to_next"] = 0
    for checkpoint in checkpoints:
        checkpoint["weather_key"] = _waypoint_key(checkpoint)
        checkpoint["elapsed_us"] = timedelta(seconds=checkpoint["elapsed_seconds"]) // timedelta(microseconds=1)
        checkpoint["micro_miles"] = round(checkpoint["miles_to_next"] * 1_000_000)
    return {**leg, "road_miles": road_miles, "checkpoints": checkpoints}


def _waypoint_key(checkpoint):
    latitude = round(checkpoint["latitude"], 4)
    longitude = round((checkpoint["longitude"] + 180) % 360 - 180, 4)
    return latitude, longitude


def _leg_departures(legs, departure):
    for leg in legs:
        yield leg, departure
        departure += timedelta(seconds=leg["duration"])


def _trip_checkpoints(legs, departure, *, compact=False):
    road_offset = 0
    for leg_index, (leg, leg_departure) in enumerate(_leg_departures(legs, departure)):
        for checkpoint in leg["checkpoints"]:
            yield {
                "leg_index": leg_index,
                **({"segment_position": checkpoint["segment_position"]} if compact else {"geometry_fraction": checkpoint["geometry_fraction"]}),
                "distance_miles": round(road_offset + checkpoint["distance_miles"], 6),
                "miles_to_next": round(checkpoint["miles_to_next"], 6),
                "latitude": checkpoint["latitude"],
                "longitude": checkpoint["longitude"],
                "eta": leg_departure + timedelta(seconds=checkpoint["elapsed_seconds"]),
            }
        road_offset += leg["road_miles"]


def _iso_utc(value):
    return value.isoformat().replace("+00:00", "Z")


def _render_steps(leg, arrival_label):
    return [{
        "instruction": step.get("instruction") or _route_instruction(step, arrival_label),
        **({"start_miles": round(step["start_distance"] * MILES_PER_METER, 5)} if "start_distance" in step else {}),
        "distance_miles": round(float(step.get("distance", 0)) * MILES_PER_METER, 3),
        "duration_minutes": round(float(step.get("duration", 0)) / 60),
    } for step in leg.get("steps", [])]


def _encoded_geometry(leg):
    if "road_revision" not in leg:
        if "encoded_geometry" not in leg:
            leg["encoded_geometry"] = encode_polyline(leg["geometry"])
        return leg["encoded_geometry"]
    key = leg["road_revision"]
    return _ENCODED_ROAD_CACHE.load_many([key], lambda _: {key: encode_polyline(leg["geometry"])})[key]


def _make_route(legs, index, departure, waypoints, forecasts, *, compact=False):
    summary = ", ".join(dict.fromkeys(leg["summary"].strip() for leg in legs if leg.get("summary")))
    directions = []
    route_legs = []
    countries = []
    for waypoint in waypoints:
        country = waypoint.get("country")
        if country and (not countries or _country_key(countries[-1]) != _country_key(country)):
            countries.append(country)

    for leg_index, (leg, leg_departure) in enumerate(_leg_departures(legs, departure)):
        start_point, end_point = waypoints[leg_index:leg_index + 2]
        start_country, end_country = start_point.get("country"), end_point.get("country")
        leg_steps = [] if compact else _render_steps(leg, end_point["label"])
        directions.extend(leg_steps)
        route_legs.append({
            "start_label": start_point["label"],
            "end_label": end_point["label"],
            "route_alternative": leg["route_alternative"],
            "available_alternatives": leg["available_alternatives"],
            "start_country": start_country,
            "end_country": end_country,
            "crosses_border": bool(start_country and end_country and _country_key(start_country) != _country_key(end_country)),
            "distance_miles": round(leg["road_miles"], 6),
            "duration_minutes": round(leg["duration"] / 60),
            "departure_time": _iso_utc(leg_departure),
            "arrival_time": _iso_utc(leg_departure + timedelta(seconds=leg["duration"])),
            "steps": leg_steps,
            **(
                {"encoded_geometry": _encoded_geometry(leg)} if compact and index == 0
                else {"coordinates": [[float(lat), float(lon)] for lon, lat in leg["geometry"]]} if not compact
                else {"geometry_pending": True}
            ),
        })

    hours = range(1 if compact else PLAYBACK_HOURS)
    checkpoints = list(_trip_checkpoints(legs, departure, compact=compact))
    for checkpoint in checkpoints:
        checkpoint["forecast"] = forecasts(checkpoint, hours)
        checkpoint["eta"] = _iso_utc(checkpoint["eta"])
    route = {
        "id": f"route-{index + 1}",
        "name": summary or f"Route {index + 1}",
        "departure_time": _iso_utc(departure),
        "distance_miles": round(sum(leg["road_miles"] for leg in legs), 3),
        "duration_minutes": round(sum(leg["duration"] for leg in legs) / 60),
        "coordinates": [] if compact else [point for leg in route_legs for point in leg["coordinates"]],
        "steps": directions,
        "legs": route_legs,
        "countries": countries,
        "checkpoints": checkpoints,
    }
    identities = [_waypoint_key(checkpoint) for checkpoint in checkpoints]
    route["metrics_by_hour"] = [_metrics_for_hour(route, hour, identities) for hour in hours]
    return route


def _stream_plan(plan, candidates, waypoints, forecast, load_playback=None):
    render = JSONRenderer().render

    def line(kind, **data):
        return render({"type": kind, **data}) + b"\n"

    initial_routes = [plan["routes"][0]]
    for route in plan["routes"][1:]:
        counts = [[-1, 0, 0] for _ in route["legs"]]
        for point in route["checkpoints"]:
            risk, covered, total = counts[point["leg_index"]]
            sample = point["forecast"][0]["risk_index"]
            if sample != RISK_INDEX["Unavailable"]:
                risk = max(risk, sample)
                covered += 1
            counts[point["leg_index"]] = [risk, covered, total + 1]
        initial_routes.append({
            **route,
            "preview_leg_weather": [
                {"risk": RISK_NAMES[risk], "count": covered, "total": total}
                for risk, covered, total in counts
            ],
        })

    yield line("plan", plan={**plan, "routes": initial_routes})
    for index, ((legs, _, _), route) in enumerate(zip(candidates, plan["routes"])):
        details = [{
            "steps": _render_steps(leg, waypoints[leg_index + 1]["label"]),
            **({"encoded_geometry": _encoded_geometry(leg)} if index > 0 else {}),
        } for leg_index, leg in enumerate(legs)]
        yield line("details", route_id=route["id"], legs=details)

    playback_forecast = load_playback() if load_playback else forecast
    reasons = {}

    @lru_cache(maxsize=32768)
    def packed_sample(key, hour):
        sample = playback_forecast.weather_at(key, hour)
        if sample[0] == "Unavailable" and playback_forecast is not forecast:
            earlier = forecast.weather_at(key, hour)
            if earlier[0] != "Unavailable":
                sample = earlier
        risk, labels, wind, rain, snow = sample
        return (
            RISK_INDEX[risk], round(wind, 1) if wind is not None else None,
            round(rain, 2) if rain is not None else None,
            round(snow, 2) if snow is not None else None,
            tuple(reasons.setdefault(reason, len(reasons)) for reason in labels),
        )

    for route in plan["routes"]:
        try:
            playback = _pack_playback(route, packed_sample)
            yield line("playback", route_id=route["id"], **playback, reasons=list(reasons))
        except Exception:
            logger.exception("Could not prepare forecast playback")
            yield line("playback_error", route_id=route["id"])


def _pack_playback(route, packed_sample):
    checkpoints = route["checkpoints"]
    keys = [_waypoint_key(point) for point in checkpoints]
    base_hours = [_forecast_hour(datetime.fromisoformat(point["eta"].replace("Z", "+00:00"))) for point in checkpoints]
    series = [
        [packed_sample(key, base_hour + offset) for offset in range(1, PLAYBACK_HOURS)]
        for key, base_hour in zip(keys, base_hours)
    ]
    metrics = [
        _route_metrics(
            ((point, RISK_NAMES[row[index][0]], key) for point, row, key in zip(checkpoints, series, keys)),
            route["duration_minutes"] * 60,
        )
        for index in range(PLAYBACK_HOURS - 1)
    ]
    return {"series": series, "metrics": metrics}


def _fetch_forecast_chunk(points, window=None):
    current_hour = int(datetime.now(timezone.utc).timestamp()) // 3600
    last_hour = window[1] if window else current_hour + FORECAST_DAYS * 24 - 1
    total_hours = min(240, max(1, last_hour - current_hour + 1))

    def load(latitude, longitude):
        latitude, longitude = round(latitude, 4), round(longitude, 4)
        query = {**_weather_query(latitude, longitude), "hours": 240, "pageSize": 24}
        hourly = {field: [] for field in ("time", *FORECAST_FIELDS)}
        for page in range((total_hours + 23) // 24):
            key = (latitude, longitude, current_hour, page, query.get("pageToken", ""))

            def fetch(keys):
                data = _get_json(f"{google.WEATHER_URL}/forecast/hours:lookup", params=dict(query), retry=False)
                parsed = google.hourly_weather(data.get("forecastHours", []), None)
                return {keys[0]: {**parsed, "next": data.get("nextPageToken")}}

            try:
                batch = _FORECAST_CACHE.load_many([key], fetch, _remaining)[key]
            except (PlanningError, TimeoutError):
                if not hourly["time"]:
                    raise
                break
            for field in hourly:
                hourly[field].extend(batch["hourly"][field])
            token = batch["next"]
            if not token or token == query.get("pageToken"):
                break
            query["pageToken"] = token
        return {"hourly": hourly}

    return _point_weather(points, load)


def _weather_severity(wind, rain, snow, load_weight):
    levels = []
    reasons = []

    if wind >= 55:
        levels.append("No Travel")
        reasons.append("Wind at or above 55 mph")
    elif wind >= 45:
        if load_weight > 30000:
            levels.append("No Travel")
            reasons.append("45+ mph wind with load over 30,000 lb")
        else:
            levels.append("Severe")
            reasons.append("Wind 45–54 mph")
    elif wind >= 35:
        if load_weight > 40000:
            levels.append("Severe")
            reasons.append("35+ mph wind with load over 40,000 lb")
        else:
            levels.append("High")
            reasons.append("Wind 35–44 mph")
    elif wind >= 25:
        levels.append("Moderate")
        reasons.append("Wind 25–34 mph")
    else:
        levels.append("Low")

    if rain > 1:
        levels.append("No Travel")
        reasons.append("Rain over 1.00 in/hr")
    elif rain >= 0.5:
        levels.append("Severe")
        reasons.append("Rain 0.50–1.00 in/hr")
    elif rain >= 0.25:
        levels.append("High")
        reasons.append("Rain 0.25–0.50 in/hr")
    elif rain >= 0.10:
        levels.append("Moderate")
        reasons.append("Rain 0.10–0.25 in/hr")

    if snow > 3:
        levels.append("No Travel")
        reasons.append("Snow over 3.00 in/hr")
    elif snow >= 2:
        levels.append("Severe")
        reasons.append("Snow 2.00–3.00 in/hr")
    elif snow >= 1:
        levels.append("High")
        reasons.append("Snow 1.00–2.00 in/hr")
    elif snow >= 0.5:
        levels.append("Moderate")
        reasons.append("Snow 0.50–1.00 in/hr")

    risk = max(levels, key=lambda value: RISK_INDEX[value])
    return risk, reasons


def _nonnegative_number(value):
    if isinstance(value, bool):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError, OverflowError):
        return None
    return number if isfinite(number) and number >= 0 else None


def _current_weather_rates(current):
    wind, rain, snow = (_nonnegative_number(current.get(field)) for field in FORECAST_FIELDS)
    interval = _nonnegative_number(current.get("interval"))
    if not interval:
        return wind, None, None
    rate_factor = 3600 / interval
    rain_rate = _nonnegative_number(rain * rate_factor) if rain is not None else None
    snow_rate = _nonnegative_number(snow * rate_factor) if snow is not None else None
    return wind, rain_rate, snow_rate


def _classify_weather(wind, rain, snow, load_weight, missing_reason):
    if None in (wind, rain, snow):
        risk, reasons = _weather_severity(wind or 0, rain or 0, snow or 0, load_weight)
        if risk == "No Travel":
            return risk, [*reasons, missing_reason]
        return "Unavailable", [missing_reason]
    return _weather_severity(wind, rain, snow, load_weight)


def _weather_values(wind, rain, snow):
    return {
        "wind_mph": round(wind, 1) if wind is not None else None,
        "rain_in_hr": round(rain, 2) if rain is not None else None,
        "snow_in_hr": round(snow, 2) if snow is not None else None,
    }


@api_view(["GET"])
@provider_budget(calls=MAX_GRID_SIDE ** 2)
def map_weather_heatmap(request):
    try:
        south = float(request.query_params["south"])
        west = float(request.query_params["west"])
        north = float(request.query_params["north"])
        east = float(request.query_params["east"])
        load_weight = float(request.query_params.get("load_weight_lb", 38500))
    except (KeyError, TypeError, ValueError):
        return Response({"error": "Valid map bounds are required.", "points": []}, status=400)
    if not (-90 <= south < north <= 90):
        return Response({"error": "Map latitude bounds are invalid.", "points": []}, status=400)
    if not 0 <= load_weight <= 200000:
        return Response({"error": "Load weight must be between 0 and 200,000 lb.", "points": []}, status=400)

    if not isfinite(east) or not isfinite(west):
        return Response({"error": "Map longitude bounds are invalid.", "points": []}, status=400)
    span = east - west
    if abs(span) >= 360:
        west, east = -180, 180
    else:
        west = (west + 180) % 360 - 180
        east = west + (span % 360)
    if east <= west:
        return Response({"error": "Map longitude bounds are invalid.", "points": []}, status=400)

    global_view = east - west >= 240 and north - south >= 120
    grid, sample_points, coverage, land_mask = heatmap_area(south, west, north, east, global_view=global_view)
    land_points = [point for point in sample_points if point["surface"] == "land"]
    try:
        responses = iter(_fetch_ambient_heatmap(land_points)) if land_points else iter(())
    except PlanningError as exc:
        return Response({"error": str(exc), "points": []}, status=502)

    heat_points = []
    for point in sample_points:
        current = next(responses, {}).get("current") if point["surface"] == "land" else None
        if not isinstance(current, dict):
            current = {}
        wind, rain, snow = _current_weather_rates(current)
        risk, reasons = _classify_weather(wind, rain, snow, load_weight, "Current weather data is incomplete for this map cell.")
        heat_points.append({
            **point,
            "temperature_f": google.number(current.get("temperature_2m")),
            "risk": risk,
            "intensity": RISK_INDEX[risk] if risk != "Unavailable" else None,
            "reasons": reasons,
            **_weather_values(wind, rain, snow),
            "time": current.get("time"),
        })
    return Response({
        "points": heat_points,
        "grid": grid,
        "coverage": coverage,
        "global_view": global_view,
        "land_mask": land_mask,
        "mask_size": MASK_SIZE,
        "timestamp": _iso_utc(datetime.now(timezone.utc)),
    })


def _epoch_us(value):
    delta = value - EPOCH
    return (delta.days * 86400 + delta.seconds) * 1_000_000 + delta.microseconds


def _forecast_hour(value):
    return _epoch_us(value) // HOUR_US


@lru_cache(maxsize=512)
def _forecast_minute(hour):
    return (EPOCH + timedelta(hours=hour)).isoformat(timespec="minutes")[:16]


@lru_cache(maxsize=512)
def _forecast_stamp(hour):
    return f"{_forecast_minute(hour)}:00Z"


def _forecast_window(candidates, now, playback=True):
    day = _epoch_us(now.replace(hour=0, minute=0, second=0, microsecond=0)) // HOUR_US
    start = min(_forecast_hour(departure) for _, departure, _ in candidates)
    end = max(_forecast_hour(departure + timedelta(seconds=duration)) for _, departure, duration in candidates)
    first = min(day + (FORECAST_DAYS - 1) * 24, max(day, start - start % 24))
    last = min(day + FORECAST_DAYS * 24 - 1, end + (PLAYBACK_HOURS - 1 if playback else 0))
    return first, last


def _provider_hour(value):
    if type(value) is int:
        return value // 3600 if value % 3600 == 0 else None
    if not isinstance(value, str) or len(value) != 16:
        return None
    try:
        hour = _forecast_hour(datetime.fromisoformat(value).replace(tzinfo=timezone.utc))
    except ValueError:
        return None
    return hour if _forecast_minute(hour) == value else None


def _forecast_axis(times):
    hours = tuple(map(_provider_hour, times))
    if hours and hours[0] is not None and all(hour == hours[0] + index for index, hour in enumerate(hours)):
        return hours[0], len(hours), None
    return 0, 0, {hour: index for index, hour in enumerate(hours) if hour is not None}


def _select_weather_points(leg_options):
    sequences = []
    all_points = set()
    endpoints = set()
    for options in leg_options:
        for leg in options:
            sequence = list(dict.fromkeys(
                checkpoint["weather_key"] for checkpoint in leg["checkpoints"]
            ))
            if not sequence:
                continue
            sequences.append(sequence)
            all_points.update(sequence)
            endpoints.update((sequence[0], sequence[-1]))

    if len(all_points) <= MAX_FORECAST_POINTS:
        return sorted(all_points), False

    # Keep each leg's endpoints, then add evenly spaced samples across every
    # available alternative. Unselected checkpoints remain visible as
    # unavailable instead of making the entire trip fail.
    selected = set(endpoints)
    sample_limit = max(MAX_FORECAST_POINTS, len(selected))
    denominator = 2
    longest_sequence = max(map(len, sequences), default=0)
    while len(selected) < sample_limit and denominator <= longest_sequence * 2:
        for numerator in range(1, denominator, 2):
            fraction = numerator / denominator
            for sequence in sequences:
                if len(sequence) < 3:
                    continue
                index = round(fraction * (len(sequence) - 1))
                if 0 < index < len(sequence) - 1:
                    selected.add(sequence[index])
                    if len(selected) >= sample_limit:
                        break
            if len(selected) >= sample_limit:
                break
        denominator *= 2

    return sorted(selected), True


def _route_weather(leg_options, load_weight, window=None):
    locations, sample_limited = _select_weather_points(leg_options)
    chunks = [locations[start:start + 45] for start in range(0, len(locations), 45)]
    weather_by_location = {}
    timeline_indices = {}
    failures = []
    with ProviderExecutor(max_workers=min(3, len(chunks)) or 1) as executor:
        futures = {
            executor.submit(
                _fetch_forecast_chunk, [{"latitude": lat, "longitude": lon} for lat, lon in chunk],
                **({"window": window} if window else {}),
            ): chunk for chunk in chunks
        }
        for future in as_completed(futures):
            chunk = futures[future]
            try:
                responses = future.result()
            except PlanningError as exc:
                failures.append(str(exc))
                continue
            if not isinstance(responses, list) or len(responses) != len(chunk):
                failures.append("The weather service returned an incomplete checkpoint forecast.")
                continue
            for key, response in zip(chunk, responses):
                hourly = response.get("hourly") if isinstance(response, dict) else None
                if not isinstance(hourly, dict) or not isinstance(hourly.get("time"), list):
                    continue
                times = tuple(hourly["time"])
                try:
                    axis = timeline_indices.get(times)
                except TypeError:
                    times = tuple(value if isinstance(value, (int, str)) else None for value in times)
                    axis = timeline_indices.get(times)
                if axis is None:
                    axis = _forecast_axis(times)
                    timeline_indices[times] = axis
                columns = tuple(hourly.get(field) for field in FORECAST_FIELDS)
                weather_by_location[key] = axis, columns

    @lru_cache(maxsize=32768)
    def weather_at(key, hour):
        wind = rain = snow = None
        reason = "Weather forecast unavailable for this checkpoint."
        if key in weather_by_location:
            (start, length, indices), columns = weather_by_location[key]
            weather_index = hour - start if indices is None else indices.get(hour)
            available = 0 <= weather_index < length if indices is None else weather_index is not None
            reason = "Forecast horizon does not cover this time."
            if available:
                wind, rain, snow = (
                    _nonnegative_number(column[weather_index]) if isinstance(column, list) and weather_index < len(column) else None
                    for column in columns
                )
                reason = "Weather data is incomplete for this time."
        risk, reasons = _classify_weather(wind, rain, snow, load_weight, reason)
        return risk, reasons, wind, rain, snow

    def forecast(checkpoint, offsets):
        key = _waypoint_key(checkpoint)
        first_hour = _forecast_hour(checkpoint["eta"])
        results = []
        for offset in offsets:
            target = first_hour + offset
            risk, reasons, wind, rain, snow = weather_at(key, target)
            results.append({
                "offset_hour": offset,
                "risk": risk,
                "risk_index": RISK_INDEX[risk],
                "reasons": reasons,
                **_weather_values(wind, rain, snow),
                "time": _forecast_stamp(target),
            })
        return results

    forecast.weather_at = weather_at

    warnings = []
    if sample_limited:
        warnings.append(
            "Weather sampling reached the service limit. Unsampled checkpoints are marked unavailable, "
            "and routes with incomplete weather are not recommended."
        )
    if failures:
        warnings.append(
            "Google Weather is rate limiting forecast requests. Affected checkpoints are marked unavailable."
            if any("HTTP 429" in failure for failure in failures)
            else "Weather forecasts could not be loaded for some checkpoints. Affected checkpoints are marked unavailable."
        )
    warning = " ".join(warnings) or None
    return forecast, warning


def _route_metrics(checkpoint_risks, duration_seconds):
    severe = high = no_travel = unknown = weighted_risk = covered_miles = 0.0
    no_travel_checkpoints = unknown_checkpoints = 0
    previous_key = None
    for sample in checkpoint_risks:
        checkpoint, risk = sample[0], sample[1]
        location = sample[2] if len(sample) == 3 else _waypoint_key(checkpoint)
        miles = checkpoint["miles_to_next"]
        key = (checkpoint["distance_miles"], location, risk)
        if key != previous_key:
            if risk == "No Travel":
                no_travel_checkpoints += 1
            elif risk == "Unavailable":
                unknown_checkpoints += 1
        previous_key = key
        if risk == "No Travel":
            no_travel += miles
        elif risk == "Severe":
            severe += miles
        elif risk == "High":
            high += miles
        elif risk == "Unavailable":
            unknown += miles
        if risk != "Unavailable":
            weighted_risk += RISK_INDEX[risk] * miles
            covered_miles += miles
    return {
        "no_travel_miles": round(no_travel, 1),
        "no_travel_checkpoints": no_travel_checkpoints,
        "severe_miles": round(severe, 1),
        "high_miles": round(high, 1),
        "unknown_miles": round(unknown, 1),
        "unknown_checkpoints": unknown_checkpoints,
        "average_risk": round(weighted_risk / covered_miles, 2) if covered_miles else None,
        "duration_minutes": round(duration_seconds / 60),
    }


def _metrics_for_hour(route, offset, identities=None):
    if identities is None:
        identities = map(_waypoint_key, route["checkpoints"])
    return _route_metrics(
        ((checkpoint, checkpoint["forecast"][offset]["risk"], key) for checkpoint, key in zip(route["checkpoints"], identities)),
        route["duration_minutes"] * 60,
    )


def _rank_key(metrics):
    return (
        bool(metrics["no_travel_miles"] or metrics["no_travel_checkpoints"]),
        metrics["no_travel_miles"],
        metrics["no_travel_checkpoints"],
        bool(metrics["unknown_miles"] or metrics["unknown_checkpoints"]),
        metrics["unknown_miles"],
        metrics["unknown_checkpoints"],
        metrics["severe_miles"],
        metrics["high_miles"],
        metrics["average_risk"] if metrics["average_risk"] is not None else 99,
        metrics["duration_minutes"],
    )


def _connected_legs(legs):
    for first, second in zip(legs, legs[1:]):
        first_lon, first_lat = first["geometry"][-1]
        second_lon, second_lat = second["geometry"][0]
        if _distance_miles({"lat": first_lat, "lon": first_lon}, {"lat": second_lat, "lon": second_lon}) > 0.05:
            return False
    return True


def _rank_trips(options, requested_time, time_mode):
    candidates = []
    skipped_time = False
    skipped_size = False
    now = datetime.now(timezone.utc)
    compatible = {
        (id(first), id(second))
        for prior, following in zip(options, options[1:])
        for first in prior for second in following if _connected_legs((first, second))
    }
    for legs in product(*options):
        if any((id(first), id(second)) not in compatible for first, second in zip(legs, legs[1:])):
            continue
        duration = sum(leg["duration"] for leg in legs)
        departure = requested_time
        if time_mode == "arrival":
            departure -= timedelta(seconds=duration)
            if departure < now:
                skipped_time = True
                continue
        if sum(len(leg["checkpoints"]) for leg in legs) > MAX_CHECKPOINTS_PER_ROUTE:
            skipped_size = True
            continue
        candidates.append((legs, departure, duration))
    if not candidates:
        if skipped_size:
            raise TripInfeasibleError("This trip needs too many checkpoints. Choose wider spacing or plan a shorter trip.")
        if skipped_time:
            raise TripInfeasibleError("This arrival time is too soon for the available routes. Choose a later arrival time.")
        raise TripInfeasibleError("The roads for adjacent legs do not meet near a stop. Move the stop closer to the road.")
    return candidates, skipped_time, skipped_size


def _rank_candidates(candidates, forecast):
    weather_at = forecast.weather_at
    memo = {}
    phase_limits = {}

    def risk_at(key, hour):
        return RISK_INDEX[weather_at(key, hour)[0]]

    def leg_metrics(leg, departure):
        leg_id = id(leg)
        if leg_id not in phase_limits:
            phase_limits[leg_id] = sorted({
                HOUR_US - point["elapsed_us"] % HOUR_US for point in leg["checkpoints"]
            })
        first_hour_us = _epoch_us(departure)
        hour, phase = divmod(first_hour_us, HOUR_US)
        key = (leg_id, hour, bisect_right(phase_limits[leg_id], phase))
        if key in memo:
            return memo[key]
        miles = [0] * 6
        counts = [0] * 6
        previous = first = last = None
        for point in leg["checkpoints"]:
            location = point["weather_key"]
            risk = risk_at(location, (first_hour_us + point["elapsed_us"]) // HOUR_US)
            last = (location, risk)
            if first is None:
                first = last
            identity = (round(point["distance_miles"], 6), last)
            if identity != previous:
                counts[risk] += 1
            previous = identity
            miles[risk] += point["micro_miles"]
        memo[key] = miles, counts, first, last
        return memo[key]

    def rank(candidate):
        legs, departure, duration = candidate
        miles = [0] * 6
        counts = [0] * 6
        previous = None
        close_endpoints = False
        for leg, start in _leg_departures(legs, departure):
            distances, occurrences, first, last = leg_metrics(leg, start)
            for risk in range(6):
                miles[risk] += distances[risk]
                counts[risk] += occurrences[risk]
            if previous == first:
                counts[first[1]] -= 1
            previous = last
            close_endpoints = close_endpoints or leg["road_miles"] < 0.000001

        covered = sum(miles[:5])
        weighted = sum(risk * miles[risk] for risk in range(5))
        average = weighted / covered if covered else None
        # Use the legacy floating-point accumulation when a rounding tie could change route order.
        near_mileage_tie = any(
            distance % 100_000 == 50_000 for distance in (miles[2], miles[3], miles[4], miles[5])
        )
        near_average_tie = average is not None and abs(average * 100 - round(average * 100)) > 0.499999999
        if close_endpoints or near_mileage_tie or near_average_tie:
            checkpoint_risks = (
                (point, weather_at(_waypoint_key(point), _forecast_hour(point["eta"]))[0])
                for point in _trip_checkpoints(legs, departure)
            )
            return _rank_key(_route_metrics(checkpoint_risks, duration))
        return _rank_key({
            "no_travel_miles": round(miles[4] / 1_000_000, 1),
            "no_travel_checkpoints": counts[4],
            "unknown_miles": round(miles[5] / 1_000_000, 1),
            "unknown_checkpoints": counts[5],
            "severe_miles": round(miles[3] / 1_000_000, 1),
            "high_miles": round(miles[2] / 1_000_000, 1),
            "average_risk": round(average, 2) if average is not None else None,
            "duration_minutes": round(duration / 60),
        })

    return nsmallest(3, candidates, key=rank)


def _first_validation_error(errors):
    while isinstance(errors, (dict, list)):
        if not errors:
            return "The request data is invalid."
        errors = next(iter(errors.values())) if isinstance(errors, dict) else errors[0]
    return str(errors)


@api_view(["POST"])
@throttle_classes([PlanThrottle])
@provider_budget(seconds=40, calls=MAX_FORECAST_POINTS * FORECAST_DAYS + 24)
def plan_routes(request):
    try:
        try:
            # Django checks the declared body size when buffering the body.
            request.body
            payload = request.data
        except RequestDataTooBig:
            return Response({"error": "The trip request is too large."}, status=413)
        except ParseError:
            return Response({"error": "Request body must be valid JSON."}, status=400)
        serializer = RoutePlanInputSerializer(data=payload)
        if not serializer.is_valid():
            return Response({"error": _first_validation_error(serializer.errors)}, status=400)
        payload = serializer.validated_data

        origin_query = payload.get("origin", "")
        origin_coordinates = payload.get("origin_coordinates")
        raw_stops = payload.get("stops")
        if raw_stops is None:
            raw_stops = [{
                "label": payload.get("destination_label") or payload.get("destination", ""),
                "coordinates": payload.get("destination_coordinates"),
            }]
        if not (origin_coordinates or origin_query):
            raise TripValidationError("Enter both an origin and destination.")

        interval = payload.get("checkpoint_interval_miles", 25)
        if not isfinite(interval):
            raise TripValidationError("Enter a valid checkpoint interval.")
        load_weight = payload.get("load_weight_lb", 0)
        time_mode = payload["time_mode"]
        requested_time = _parse_departure(payload.get("requested_time") or payload.get("departure_time"))
        now = datetime.now(timezone.utc)
        forecast_end = now.replace(hour=0, minute=0, second=0, microsecond=0) + timedelta(days=FORECAST_DAYS)
        if requested_time < now - timedelta(minutes=1):
            raise TripInfeasibleError("Choose a trip time in the future.")
        if requested_time >= forecast_end:
            raise TripInfeasibleError("Choose a trip time within the available seven-day forecast.")

        compact = request.query_params.get("delivery") == "progressive"
        timings = {}
        stage_start = monotonic()

        def complete_stage(name):
            nonlocal stage_start
            end = monotonic()
            timings[name] = (end - stage_start) * 1000
            stage_start = end

        waypoints = [None]
        missing = {}
        if origin_coordinates:
            waypoints[0] = _coordinates_from_payload(origin_coordinates, payload.get("origin_label") or origin_query)
        else:
            missing[0] = origin_query
        for stop in raw_stops:
            label = stop.get("label", "")
            coordinates = stop.get("coordinates")
            if coordinates is None and "lat" in stop and "lon" in stop:
                coordinates = stop
            if coordinates:
                waypoints.append(_coordinates_from_payload({
                    **coordinates, "country": coordinates.get("country") or stop.get("country"),
                }, label or "Trip stop"))
            elif label:
                missing[len(waypoints)] = label
                waypoints.append(None)
            else:
                raise TripValidationError("Choose a location for every destination and stop.")

        if missing:
            with ProviderExecutor(max_workers=min(4, len(missing))) as executor:
                lookups = {index: executor.submit(_geocode, query) for index, query in missing.items()}
                for index, future in lookups.items():
                    waypoints[index] = future.result()

        if any(_same_waypoint(first, second) for first_index, first in enumerate(waypoints) for second in waypoints[first_index + 1:]):
            raise TripValidationError("A trip cannot use the same location for multiple waypoints. Choose a different place for each point.")
        complete_stage("geocode")

        with ProviderExecutor(max_workers=4) as executor:
            countries = {
                index: executor.submit(_country_for_waypoint, waypoint)
                for index, waypoint in enumerate(waypoints) if not waypoint.get("country")
            }
            leg_options = _get_leg_options(waypoints)
            complete_stage("roads")
            prepared = [[_prepare_leg(leg, interval, compact=compact) for leg in options] for options in leg_options]
            candidates, skipped_time, skipped_size = _rank_trips(prepared, requested_time, time_mode)
            used_legs = {id(leg): leg for legs, _, _ in candidates for leg in legs}
            complete_stage("prepare")
            forecasts, weather_warning = _route_weather(
                [used_legs.values()], load_weight, _forecast_window(candidates, now, playback=not compact),
            )
            complete_stage("weather")
            chosen = _rank_candidates(candidates, forecasts)
            complete_stage("rank")
            for index, future in countries.items():
                waypoints[index]["country"] = future.result()
        complete_stage("metadata")
        routes = [
            _make_route(legs, index, departure, waypoints, forecasts, compact=compact)
            for index, (legs, departure, _) in enumerate(chosen)
        ]
        best = routes[0]
        best_metrics = best["metrics_by_hour"][0]
        eligible = not (best_metrics["no_travel_checkpoints"] or best_metrics["unknown_checkpoints"])
        recommendation = best["id"] if eligible else None
        warnings = []
        if len(routes) < 3:
            warnings.append(f"Found {len(routes)} distinct complete trip route{'s' if len(routes) != 1 else ''}.")
        if skipped_time:
            warnings.append("Some alternatives require an earlier departure than is possible for this arrival time.")
        if skipped_size:
            warnings.append("Some alternatives need more checkpoints than this request can support.")
        if not weather_warning and any(route["metrics_by_hour"][0]["unknown_checkpoints"] for route in routes):
            weather_warning = "Some checkpoints are outside the available forecast or have incomplete weather data."
        plan = {
            "origin": waypoints[0],
            "destination": waypoints[-1],
            "stops": waypoints[1:],
            "departure_time": best["departure_time"],
            "requested_time": _iso_utc(requested_time),
            "time_mode": time_mode,
            "load_weight_lb": load_weight,
            "checkpoint_interval_miles": interval,
            "routes": routes,
            "recommended_route_id": recommendation,
            "route_warning": " ".join(warnings) or None,
            "weather_warning": weather_warning,
            "source_notice": "Routes use a general driving profile. Verify truck restrictions, closures, and official advisories before dispatch.",
            "weather_source": "Google Maps Platform Weather API",
            "routing_source": "Google Maps Platform Routes API",
        }
        complete_stage("materialize")
        headers = {"Server-Timing": ", ".join(f"{name};dur={value:.2f}" for name, value in timings.items())}
        if compact:
            budget = _PROVIDER_BUDGET.get()

            def load_playback():
                token = _PROVIDER_BUDGET.set(budget)
                try:
                    legs_to_display = {id(leg): leg for legs, _, _ in chosen for leg in legs}
                    return _route_weather([legs_to_display.values()], load_weight, _forecast_window(chosen, now))[0]
                finally:
                    _PROVIDER_BUDGET.reset(token)

            return StreamingHttpResponse(
                _stream_plan(plan, chosen, waypoints, forecasts, load_playback),
                content_type="application/x-ndjson",
                headers={**headers, "X-Accel-Buffering": "no", "Cache-Control": "no-store"},
            )
        return Response(plan, headers={**headers, "Cache-Control": "no-store"})
    except TripValidationError as exc:
        return Response({"error": str(exc)}, status=400)
    except TripInfeasibleError as exc:
        return Response({"error": str(exc)}, status=422)
    except PlanningError as exc:
        return Response({"error": str(exc)}, status=502)
    except Exception:
        logger.exception("Unexpected route planning failure")
        return Response({"error": "Route planning failed. Try again shortly."}, status=500)
