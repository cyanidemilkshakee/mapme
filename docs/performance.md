# Planner latency


### Before and after

These historical benchmark results use synthetic trips with simulated routing and weather providers. They predate the Google Maps migration. The largest trip has five legs, three road alternatives per leg, and 75,000 vertices across all road alternatives. Ranking times are medians. Payload sizes are exact bytes compressed with gzip level 1.

| Trip | Route combinations | Ranking time before → after | Bytes to first route before → after | Bytes through playback before → after |
| --- | ---: | ---: | ---: | ---: |
| Short | 2 | 0.33 → 0.09 ms | 14,460 → 1,945 | 14,460 → 4,867 |
| Medium | 27 | 11.56 → 1.22 ms | 334,579 → 15,829 | 334,579 → 52,150 |
| Large | 243 | 560.77 → 19.66 ms | 1,827,113 → 62,622 | 1,827,113 → 226,707 |

The old browser path needed the full JSON response before it could show a route. On the large trip, ranking is **28.5× faster**, the first compressed response is **96.6% smaller**, and the full playback response is **87.6% smaller**.

| Large-trip backend timing after the changes | Cold geometry | Cached geometry |
| --- | ---: | ---: |
| First route event ready | 86.56 ms | 39.59 ms |
| All playback events ready | 387.09 ms | 259.51 ms |

These local medians exclude live provider calls, production proxy and queue delays, and browser rendering. Live latency percentiles and frame times on low-end devices remain unmeasured.

### Data structures and algorithms

| Area | Implementation | Effect on work |
| --- | --- | --- |
| Provider reuse | A size- and count-bounded in-process LRU uses an ordered dictionary, with Redis for Google Weather results shared across workers. A hash map of pending futures coalesces concurrent misses for the same key within a worker. A bounded thread pool fetches missing weather pages over pooled HTTP connections. | Local hits and individual evictions take expected `O(1)`. Overlapping requests fetch each missing weather page once per worker while the first fetch is in flight. Road geometry encoding is reused within a plan. |
| Checkpoint placement | Prefix sums store cumulative road lengths and durations. Binary search finds the bracketing segment and linear interpolation places each checkpoint. The compact path sends the segment index and fraction to the browser. | For `V` vertices and `P` checkpoints on a leg, preparation is `O(V + P log V)`. The browser slices the polyline in `O(V + P)` and skips recomputing geodesic distances when positions are supplied. |
| Forecast lookup | A hash set deduplicates checkpoint coordinates. Hourly weather values live in arrays indexed by the difference from the first UTC hour. Irregular timelines use an hour-to-index hash map. A bounded cache reuses classifications by coordinate and hour within a plan. | After the index is built, a forecast lookup takes `O(1)` on an aligned timeline and expected `O(1)` on the irregular fallback. |
| Route ranking | A hash set stores compatible pairs of adjacent road legs. The ranker memoizes each leg's risk totals by departure hour and by the interval between checkpoint hour boundaries. It finds that interval with binary search, adds integer millionths of a mile in fixed-size risk buckets, and falls back to the original checkpoint scorer for cases sensitive to rounding. | Once a leg's hour boundaries are indexed, each distinct timing state scans its checkpoints once. A cache hit finds the state in `O(log P)` for `P` checkpoints on that leg. The planner still checks the Cartesian product of alternatives. |
| Top-three selection | A bounded heap keeps the three best ranked candidates with stable tie ordering. | Selection from `C` candidates takes `O(C log k)` time and `O(k)` extra heap space for `k = 3`, excluding candidate generation and scoring. |
| Progressive delivery | NDJSON sends the ranked routes and selected map first, then directions, alternate geometry, and playback. Polyline6 stores coordinate deltas. Playback arrays store compact numeric samples and refer to repeated reason strings by integer ID. The browser joins buffered fragments once per complete event. | Network transfer and parsing for the first route proceed independently of full playback. Feed parsing is linear in the bytes received. |
| Map rendering and interaction | One Canvas reuses projected `Path2D` objects at the current zoom. Bounds checks skip offscreen paths, and `requestAnimationFrame` coalesces redraws. A hash grid places checkpoints in 24-pixel cells and tests the clicked cell and its eight neighbors. | A hit test at a fixed zoom scans only nearby buckets. Worst-case lookup is `O(P)` if `P` checkpoints cluster in those buckets. |
| Rate limiting | Redis sorted sets store request timestamps. One atomic Lua script updates the API and planner sliding windows together. | The steady-state Redis path checks both quotas in one round trip and prunes expired entries by score. |

### Reproduce the benchmark

```bash
PYTHONPATH=backend python backend/benchmarks/route_plan.py
PYTHONPATH=backend python backend/benchmarks/route_plan.py --case large --warm
```

The [benchmark script](../backend/benchmarks/route_plan.py) exercises the progressive Django endpoint directly. By default it records seven runs per case after a warm-up and reports stage medians, time to the first event, time through playback, and compressed sizes. `--warm` enables synthetic prepared-geometry cache reuse to isolate computation costs. Run these commands to measure the current implementation on your machine. The before values come from the pre-optimization audit.

The browser uses `POST /api/route-plans?delivery=progressive`. The first NDJSON event contains the ranked routes and the selected route’s map at hour zero. Later events deliver directions, alternate geometry, and forecast playback. The default endpoint still returns the full JSON response. The API exposes the first-response stages in the `Server-Timing` header. Preserve `X-Accel-Buffering: no` through reverse proxies so the first event can reach the browser immediately.
