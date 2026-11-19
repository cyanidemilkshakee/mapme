"""Normalize Google Maps Platform responses to MapMe's route and weather models."""

from datetime import datetime
from math import asin, cos, isfinite, radians, sin, sqrt


ROUTES_URL = "https://routes.googleapis.com/directions/v2:computeRoutes"
PLACES_URL = "https://places.googleapis.com/v1/places"
GEOCODE_URL = "https://geocode.googleapis.com/v4/geocode"
WEATHER_URL = "https://weather.googleapis.com/v1"
PLACES_FIELDS = "id,displayName,formattedAddress,location,addressComponents,primaryTypeDisplayName,attributions"
ROUTE_FIELDS = (
    "routes.distanceMeters,routes.duration,routes.description,routes.polyline.encodedPolyline,"
    "routes.legs.steps.distanceMeters,routes.legs.steps.staticDuration,"
    "routes.legs.steps.navigationInstruction.instructions,routes.legs.steps.polyline.encodedPolyline"
)
MILES_PER_METER = 1 / 1609.344


def coordinates(point):
    return {"latitude": point["lat"], "longitude": point["lon"]}


def route_request(start, end):
    return {
        "origin": {"location": {"latLng": coordinates(start)}},
        "destination": {"location": {"latLng": coordinates(end)}},
        "travelMode": "DRIVE",
        "routingPreference": "TRAFFIC_UNAWARE",
        "polylineQuality": "HIGH_QUALITY",
        "computeAlternativeRoutes": True,
        "languageCode": "en",
    }


def number(value):
    if isinstance(value, bool) or not isinstance(value, (float, int)):
        return None
    return value if isfinite(value) else None


def nonnegative(value):
    value = number(value)
    return value if value is not None and value >= 0 else None


def duration(value):
    if not isinstance(value, str) or not value.endswith("s"):
        return None
    try:
        return nonnegative(float(value[:-1]))
    except ValueError:
        return None


def decode_polyline(encoded):
    if not isinstance(encoded, str):
        return []
    coordinates = []
    latitude = longitude = value = shift = 0
    axis = 0
    for char in encoded:
        part = ord(char) - 63
        if not 0 <= part <= 63 or shift > 30:
            return []
        value |= (part & 31) << shift
        shift += 5
        if part >= 32:
            continue
        delta = ~(value >> 1) if value & 1 else value >> 1
        if axis == 0:
            latitude += delta
        else:
            longitude += delta
            if abs(latitude) > 90_00000 or abs(longitude) > 180_00000:
                return []
            coordinates.append([longitude / 100_000, latitude / 100_000])
        axis = 1 - axis
        value = shift = 0
    return coordinates if not axis and not shift else []


def segment_lengths(path):
    lengths = []
    for (lon1, lat1), (lon2, lat2) in zip(path, path[1:]):
        hav = sin(radians(lat2 - lat1) / 2) ** 2 + cos(radians(lat1)) * cos(radians(lat2)) * sin(radians(lon2 - lon1) / 2) ** 2
        lengths.append(2 * asin(sqrt(max(0, min(1, hav)))))
    return lengths


def road_option(route):
    distance = nonnegative(route.get("distanceMeters"))
    seconds = duration(route.get("duration"))
    road = decode_polyline((route.get("polyline") or {}).get("encodedPolyline"))
    legs = route.get("legs") or []
    if not distance or seconds is None or len(road) < 2 or len(legs) != 1:
        return None

    steps = []
    path = []
    distances = []
    durations = []
    aligned = True
    traversed = 0.0
    for step in legs[0].get("steps") or []:
        step_path = decode_polyline((step.get("polyline") or {}).get("encodedPolyline"))
        step_distance = nonnegative(step.get("distanceMeters")) or 0
        step_seconds = duration(step.get("staticDuration"))
        instruction = (step.get("navigationInstruction") or {}).get("instructions")
        steps.append({
            "distance": step_distance, "duration": step_seconds or 0,
            "instruction": instruction if isinstance(instruction, str) else "",
            "start_distance": traversed,
        })
        traversed += step_distance
        if len(step_path) < 2:
            aligned = aligned and not step_distance and not step_seconds
            continue
        lengths = segment_lengths(step_path)
        total = sum(lengths)
        if not total or step_seconds is None or (path and step_path[0] != path[-1]):
            aligned = False
            continue
        distances.extend(length / total * step_distance for length in lengths)
        durations.extend(length / total * step_seconds for length in lengths)
        path.extend(step_path[1:] if path else step_path)

    if traversed:
        for step in steps:
            step["start_distance"] *= distance / traversed
    annotation = None
    if aligned and len(path) > 1 and path[0] == road[0] and path[-1] == road[-1] and sum(distances):
        road = path
        annotation = {"distance": distances, "duration": durations}
    return {
        "summary": route.get("description") or "", "geometry": road, "annotation": annotation,
        "steps": steps, "distance": distance, "duration": seconds,
    }


def country(components):
    return next((part.get("longText") for part in components or [] if "country" in part.get("types", [])), None)


def place_result(place):
    location = place.get("location") or {}
    lat, lon = number(location.get("latitude")), number(location.get("longitude"))
    place_id = place.get("id")
    if not place_id or lat is None or lon is None or not (-90 <= lat <= 90 and -180 <= lon <= 180):
        return None
    address = place.get("formattedAddress") or ""
    name = (place.get("displayName") or {}).get("text") or address
    if not name:
        return None
    return {
        "id": place_id, "name": name, "label": address or name, "detail": address, "address": address,
        "lat": lat, "lon": lon, "country": country(place.get("addressComponents")),
        "category": (place.get("primaryTypeDisplayName") or {}).get("text"),
        "attributions": [
            {"name": value["provider"], "url": value.get("providerUri") or ""}
            for value in place.get("attributions", []) if value.get("provider")
        ],
        "photos": [],
    }


def measurement(value, field, imperial, metric, factor):
    amount = nonnegative((value or {}).get(field))
    unit = (value or {}).get("unit")
    if amount is None:
        return None
    if unit == imperial:
        return amount
    if unit == metric:
        # Suppress binary conversion noise at classification thresholds.
        return round(amount * factor, 12)
    return None


def weather_values(sample):
    wind = sample.get("wind") or {}
    wind_speed = measurement(wind.get("speed"), "value", "MILES_PER_HOUR", "KILOMETERS_PER_HOUR", 1 / 1.609344)
    precipitation = sample.get("precipitation") or {}
    amount = measurement(precipitation.get("qpf"), "quantity", "INCHES", "MILLIMETERS", 1 / 25.4)
    snow = measurement(precipitation.get("snowQpf"), "quantity", "INCHES", "MILLIMETERS", 1 / 25.4)
    kind = (precipitation.get("probability") or {}).get("type")
    condition = (sample.get("weatherCondition") or {}).get("type") or ""
    # The risk model has no thresholds for ice or hail; do not classify them as dry or rain.
    if kind in ("FREEZING_RAIN", "SLEET", "PRECIPITATION_TYPE_HAIL") or "HAIL" in condition:
        return wind_speed, None, snow
    if amount == 0 and (snow == 0 or (snow is None and kind not in ("SNOW", "RAIN_AND_SNOW", "SLEET") and "SNOW" not in condition)):
        return wind_speed, 0, 0
    if kind == "SNOW" and "RAIN" not in condition:
        return wind_speed, 0, snow
    if kind in ("RAIN", "LIGHT_RAIN", "HEAVY_RAIN") and ("SNOW" not in condition and not snow):
        return wind_speed, amount, 0 if snow is None else snow
    # QPF can include several forms of precipitation. Preserve missing rain amounts.
    return wind_speed, None, snow


def temperature(value):
    amount = number((value or {}).get("degrees"))
    if amount is None:
        return None
    unit = (value or {}).get("unit")
    if unit == "FAHRENHEIT":
        return amount
    if unit == "CELSIUS":
        return amount * 9 / 5 + 32
    return None


def current_weather(data):
    wind, rain, snow = weather_values(data)
    return {"current": {
        "interval": 3600, "time": data.get("currentTime"),
        "condition": ((data.get("weatherCondition") or {}).get("description") or {}).get("text"),
        "temperature_2m": temperature(data.get("temperature")),
        "apparent_temperature": temperature(data.get("feelsLikeTemperature")),
        "relative_humidity_2m": nonnegative(data.get("relativeHumidity")),
        "wind_speed_10m": wind, "rain": rain, "snowfall": snow,
        "wind_gusts_10m": measurement((data.get("wind") or {}).get("gust"), "value", "MILES_PER_HOUR", "KILOMETERS_PER_HOUR", 1 / 1.609344),
    }}


def hourly_weather(records, window):
    time, wind, rain, snow = [], [], [], []
    for record in records:
        raw_time = (record.get("interval") or {}).get("startTime")
        if not isinstance(raw_time, str):
            continue
        try:
            stamp = int(datetime.fromisoformat(raw_time.replace("Z", "+00:00")).timestamp())
        except (ValueError, OverflowError, OSError):
            continue
        if not window or window[0] <= stamp // 3600 <= window[1]:
            time.append(stamp)
            speed, rainfall, snowfall = weather_values(record)
            wind.append(speed)
            rain.append(rainfall)
            snow.append(snowfall)
    return {"hourly": {"time": time, "wind_speed_10m": wind, "rain": rain, "snowfall": snow}}
