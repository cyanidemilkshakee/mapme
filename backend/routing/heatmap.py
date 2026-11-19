"""Prepare a land mask and bounded weather sample grid for the temperature overlay."""

from array import array
from base64 import b64encode
from bisect import bisect_right
from functools import lru_cache
import gzip
from math import asinh, atan, ceil, cos, degrees, radians, sin, sinh, tan
from pathlib import Path
from sys import byteorder


MERCATOR_LIMIT = 85.0511287798
MASK_SIZE = 288
MAX_GRID_SIDE = 8
GLOBAL_GRID_SIDE = 5
_MASK_FILE = Path(__file__).with_name("data") / "land_mask.bin.gz"
_STEPS = 100


@lru_cache(maxsize=1)
def _land_rows():
    packed = array("H")
    with gzip.open(_MASK_FILE, "rb") as source:
        packed.frombytes(source.read())
    if byteorder == "big":
        packed.byteswap()
    offset = 0
    rows = []
    for _ in range(180 * _STEPS):
        end = offset + packed[offset] + 1
        rows.append(packed[offset + 1:end])
        offset = end
    return rows


def _longitude_column(longitude):
    return int((longitude + 180) % 360 * _STEPS)


def _latitude_row(latitude):
    return int((latitude + 90) * _STEPS)


def _mask_rows(latitudes, longitudes):
    coast = _land_rows()
    columns = [_longitude_column(longitude) for longitude in longitudes]
    west, east = min(columns), max(columns)
    full_row = (1 << MASK_SIZE) - 1

    @lru_cache(maxsize=MASK_SIZE)
    def project_row(source_row):
        edges = coast[source_row]
        if not edges:
            return 0
        if len(edges) == 2 and edges[0] <= west <= east < edges[1]:
            return full_row
        return sum(1 << x for x, column in enumerate(columns) if bisect_right(edges, column) % 2)

    return [project_row(_latitude_row(latitude)) for latitude in latitudes]


def _sample_cell(mask, x0, x1, y0, y1):
    """Find the land pixel closest to the cell center, or mark the cell as water."""
    x = (x0 + x1 - 1) // 2
    y = (y0 + y1 - 1) // 2
    if mask[y] & (1 << x):
        return x, y, True

    best = MASK_SIZE ** 2 * 2
    selected_x, selected_y = x, y
    cell_bits = ((1 << x1) - 1) ^ ((1 << x0) - 1)
    left_bits = (1 << x) - 1
    for row in range(y0, y1):
        bits = mask[row] & cell_bits
        if not bits:
            continue
        left = bits & left_bits
        right = bits ^ left
        for point in (left.bit_length() - 1, (right & -right).bit_length() - 1):
            if point < 0:
                continue
            distance = (point - x) ** 2 + (row - y) ** 2
            if distance < best:
                best, selected_x, selected_y = distance, point, row
    return selected_x, selected_y, best < MASK_SIZE ** 2 * 2


def _world_samples(mask, latitudes, longitudes):
    # Farthest-first sampling spreads the existing budget across land in
    # physical distance. Equal Web Mercator cells oversample the poles.
    candidates = []
    for y in range(2, MASK_SIZE, 4):
        lat = radians(latitudes[y])
        for x in range(2, MASK_SIZE, 4):
            if mask[y] & (1 << x):
                lon = radians(longitudes[x])
                candidates.append((x, y, cos(lat) * cos(lon), cos(lat) * sin(lon), sin(lat)))

    # Seed an inland Antarctic point so the coast is not the only source
    # for the continent's temperature range.
    plateau_lat, plateau_lon = radians(-82), radians(85)
    vx, vy, vz = cos(plateau_lat) * cos(plateau_lon), cos(plateau_lat) * sin(plateau_lon), sin(plateau_lat)
    index = max(range(len(candidates)), key=lambda i: vx * candidates[i][2] + vy * candidates[i][3] + vz * candidates[i][4])
    similarities = [-1.0] * len(candidates)
    points = []
    for _ in range(GLOBAL_GRID_SIDE ** 2):
        x, y, vx, vy, vz = candidates[index]
        points.append({"latitude": round(latitudes[y], 5), "longitude": round(longitudes[x], 5), "surface": "land"})
        # Larger dot products are nearer. Select the candidate farthest from
        # all points already chosen, breaking ties by the fixed scan order.
        for i, (_, _, cx, cy, cz) in enumerate(candidates):
            similarities[i] = max(similarities[i], vx * cx + vy * cy + vz * cz)
        similarities[index] = 1
        index = min(range(len(candidates)), key=similarities.__getitem__)
    return points


def _heatmap_area(south, west, north, east, global_view):
    south, north = max(south, -MERCATOR_LIMIT), min(north, MERCATOR_LIMIT)
    grid = {"south": south, "west": west, "north": north, "east": east, "rows": 0, "columns": 0}
    if south >= north:
        return grid, [], "outside-map", None

    top = asinh(tan(radians(north)))
    height = top - asinh(tan(radians(south)))
    span = east - west
    latitudes = [degrees(atan(sinh(top - (y + 0.5) * height / MASK_SIZE))) for y in range(MASK_SIZE)]
    longitudes = [west + (x + 0.5) * span / MASK_SIZE for x in range(MASK_SIZE)]
    mask = _mask_rows(latitudes, longitudes)
    if not any(mask):
        return grid, [], "water", None

    rows = GLOBAL_GRID_SIDE if global_view else min(MAX_GRID_SIDE, max(3, ceil((north - south) * 111 / 250)))
    columns = GLOBAL_GRID_SIDE if global_view else min(MAX_GRID_SIDE, max(3, ceil(span * 111 * cos(radians((south + north) / 2)) / 250)))
    grid.update(rows=rows, columns=columns)
    if global_view:
        points = _world_samples(mask, latitudes, longitudes)
    else:
        points = []
        for row in reversed(range(rows)):
            for column in range(columns):
                x0, x1 = column * MASK_SIZE // columns, (column + 1) * MASK_SIZE // columns
                y0, y1 = row * MASK_SIZE // rows, (row + 1) * MASK_SIZE // rows
                x, y, land = _sample_cell(mask, x0, x1, y0, y1)
                points.append({"latitude": round(latitudes[y], 5), "longitude": round((longitudes[x] + 180) % 360 - 180, 5),
                               "surface": "land" if land else "water"})
    if all(row.bit_count() == MASK_SIZE for row in mask):
        return grid, points, "land", None
    bitmap = b"".join(row.to_bytes(MASK_SIZE // 8, "little") for row in mask)
    return grid, points, "mixed", b64encode(bitmap).decode("ascii")


@lru_cache(maxsize=1)
def _world_heatmap_area():
    return _heatmap_area(-MERCATOR_LIMIT, -180, MERCATOR_LIMIT, 180, global_view=True)


def heatmap_area(south, west, north, east, global_view=False):
    if global_view:
        # Keep sample coordinates and the raster stable as the globe pans.
        return _world_heatmap_area()
    return _heatmap_area(south, west, north, east, global_view=False)
