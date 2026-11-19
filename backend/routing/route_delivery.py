"""Compact geometry encoding for progressive browser responses."""


def encode_polyline(coordinates):
    previous_lat = previous_lon = 0
    encoded = []
    for lon, lat in coordinates:
        lat, lon = round(lat * 1_000_000), round(lon * 1_000_000)
        for delta in (lat - previous_lat, lon - previous_lon):
            value = (delta << 1) if delta >= 0 else ~(delta << 1)
            while value >= 32:
                encoded.append(chr((32 | (value & 31)) + 63))
                value >>= 5
            encoded.append(chr(value + 63))
        previous_lat, previous_lon = lat, lon
    return "".join(encoded)
