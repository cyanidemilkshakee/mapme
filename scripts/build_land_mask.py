"""Build the heatmap mask from Natural Earth's 1:10m land and lakes ZIP files."""

import argparse
import gzip
from math import ceil
from pathlib import Path
from struct import iter_unpack, pack, unpack_from
from zipfile import ZipFile


STEPS = 100  # Pixel centers every 0.01 degrees in WGS84.
WIDTH, HEIGHT = 360 * STEPS, 180 * STEPS


def polygon_rings(path):
    with ZipFile(path) as archive:
        shapes = archive.read(f"{path.stem}.shp")
    offset = 100
    while offset < len(shapes):
        words = unpack_from(">i", shapes, offset + 4)[0]
        record = memoryview(shapes)[offset + 8:offset + 8 + words * 2]
        offset += 8 + words * 2
        if unpack_from("<i", record)[0] != 5:
            raise ValueError(f"Expected Polygon in {path.name}")
        parts, count = unpack_from("<ii", record, 36)
        starts = unpack_from(f"<{parts}i", record, 44) + (count,)
        points = list(iter_unpack("<dd", record[44 + parts * 4:]))
        for start, end in zip(starts, starts[1:]):
            yield points[start:end]


def scanlines(path):
    rows = [[] for _ in range(HEIGHT)]
    for ring in polygon_rings(path):
        for (x0, y0), (x1, y1) in zip(ring, ring[1:]):
            if y1 < y0:
                x0, x1, y0, y1 = x1, x0, y1, y0
            start = max(0, ceil((y0 + 90) * STEPS - 0.5))
            stop = min(HEIGHT, ceil((y1 + 90) * STEPS - 0.5))
            if start >= stop:
                continue
            slope = (x1 - x0) / (y1 - y0)
            for row in range(start, stop):
                latitude = (row + 0.5) / STEPS - 90
                x = ceil((x0 + (latitude - y0) * slope + 180) * STEPS - 0.5)
                rows[row].append(max(0, min(WIDTH, x)))
    return rows


def subtract_water(land, water):
    events = {}
    for edges, flag in ((land, 1), (water, 2)):
        for x in edges:
            events[x] = events.get(x, 0) ^ flag
    state = 0
    result = []
    for x, adjustment in sorted(events.items()):
        next_state = state ^ adjustment
        if (state == 1) != (next_state == 1):
            result.append(x)
        state = next_state
    if state:
        raise ValueError("Natural Earth polygon did not close at the map boundary")
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("land", type=Path)
    parser.add_argument("lakes", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    land, lakes = scanlines(args.land), scanlines(args.lakes)
    with args.output.open("wb") as raw, gzip.GzipFile(fileobj=raw, filename="", mode="wb", mtime=0) as output:
        for land_row, lake_row in zip(land, lakes):
            edges = subtract_water(land_row, lake_row)
            output.write(pack(f"<{len(edges) + 1}H", len(edges), *edges))


if __name__ == "__main__":
    main()
