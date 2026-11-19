# MapMe

MapMe is a weather-aware route planner that compares driving routes by forecast conditions, load-sensitive wind risk, and estimated travel time. It supports multiple stops, forecast playback, and optional live trip tracking.

| Interface | Purpose | Path |
| --- | --- | --- |
| Route planner | Search for locations, compare routes, and follow a trip | `/` |
| Settings | Choose appearance, units, and time zone, then save your changes | `/settings` |

## Stack

- React 19, TypeScript, Vite, and Material UI
- Django, Django REST Framework, and Python
- Google Maps JavaScript, Routes, Places, Geocoding, and Weather APIs
- SQLite for application data and Redis for shared caching and rate limiting
- Docker Compose and Kubernetes manifests for deployment

Python 3.10 or newer and Node.js 22.12 or newer are required.

## API routes

| Path | Purpose |
| --- | --- |
| `/api/route-plans` | Plan and compare routes; supports progressive delivery |
| `/api/locations/search` | Search for locations |
| `/api/locations/details` and `/api/locations/photos` | Retrieve place details and photos |
| `/api/locations/nearby` | Search nearby places |
| `/api/weather/heatmap` | Retrieve current air temperatures and weather samples for the visible map area |
| `/api/maps/config` | Provide the browser-restricted Maps key |
| `/api/health` and `/api/ready` | Check process liveness and database readiness |

`/api/routes/plan` is also available as a route-planning endpoint.

## Docker

If you need an environment file, copy `.env.example` to `.env` and set the Google keys as described in [Google Maps configuration](#google-maps-configuration). Then run the full stack:

```bash
docker compose up --build --wait
```

Open [http://127.0.0.1:10001](http://127.0.0.1:10001). Kong serves both the website and API on IPv4 loopback port 10001. Change it with `WEB_PORT`. Django, Nginx, both Redis services, and Kong’s control interfaces have no published ports. SQLite persists in the `backend_data` volume. `docker compose down` stops the services; add `--volumes` only when intentionally deleting the database volume.

## Local development

Copy `.env.example` to `.env` and configure the Google Maps keys as described below:

```bash
cp .env.example .env
```

Start Redis if available; Django defaults to `redis://127.0.0.1:6379/1` and uses a short-lived in-process fallback if Redis is unavailable.

Install the backend and frontend dependencies once:

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r backend/requirements.txt
npm --prefix frontend ci
```

Then start both services from the project root:

```bash
npm run dev
```

The command loads `.env`, applies database migrations, and starts Django and Vite. Use local settings and leave `SPOTTER_GATEWAY_TOKEN` empty for this direct loopback development path. Press Ctrl+C to stop both servers. Open [http://127.0.0.1:10001](http://127.0.0.1:10001); Vite proxies `/api` requests to Django on port 10002. Redis runs separately and is optional for local development.

Useful commands from the project root:

| Command | Purpose |
| --- | --- |
| `npm run dev` | Apply migrations and start the local backend and frontend |
| `python backend/manage.py check` | Check Django configuration |
| `python backend/manage.py test routing` | Run backend regression tests |
| `npm --prefix frontend run lint` | Lint frontend code |
| `npm --prefix frontend test` | Run frontend tests |
| `npm --prefix frontend run build` | Type-check and build the frontend |
| `docker compose config --quiet` | Validate the Compose configuration |
| `python -m unittest discover -s gateway` | Check Kong configuration rules |

## Google Maps configuration

Enable billing and the required APIs in Google Cloud. Keep `.env` out of version control.

| Environment variable | API restrictions |
| --- | --- |
| `GOOGLE_MAPS_API_KEY` | Routes API, Places API (New), Geocoding API, and Weather API. Keep this key server-side and restrict it to your server's outbound IP in production. |
| `GOOGLE_MAPS_BROWSER_KEY` | Maps JavaScript API and your frontend's HTTP referrers, such as `http://127.0.0.1:10001/*` for Vite. Add the production HTTPS origin when deploying. |
| `GOOGLE_WEATHER_MAX_POINTS` | Maximum distinct weather coordinates per trip; defaults to 120 and accepts 9–300. |

Django publishes the browser-restricted key through `/api/maps/config`. Vite and Nginx proxy the endpoint, so key changes require a backend restart but no frontend rebuild. Follow [Google's API key security guidance](https://developers.google.com/maps/api-security-best-practices).

## Route planning and live trips

Google Maps supplies the street and satellite basemap. The temperature heatmap blends current Google Weather air-temperature readings over land. World views reuse the same 25 samples, spaced by physical distance across land. Regional views use at most 64 samples. Interpolation fades beyond the sampling range, which grows at wider zooms. Zoom in for local estimates. Antarctica uses southern polar readings and lakes, seas, and oceans stay clear. The weather button above the zoom controls toggles the layer. The continuous color scale is under **Settings → Info → Temperature heatmap** and follows the selected temperature unit.

The land mask uses [Natural Earth 1:10m land and lakes](https://www.naturalearthdata.com/downloads/10m-physical-vectors/) at 0.01° resolution. To regenerate it, download `ne_10m_land.zip` (5.1.1) and `ne_10m_lakes.zip` (5.0.0) and run `python3 scripts/build_land_mask.py ne_10m_land.zip ne_10m_lakes.zip backend/routing/data/land_mask.bin.gz`.

Google Routes supplies driving alternatives and turn descriptions. The planner compares connected combinations and ranks up to three routes for the requested time. Google Weather provides current and hourly conditions for up to seven UTC days. Forecast gaps and No Travel checkpoints disqualify a route from recommendation. Mixed precipitation can remain unavailable when Google supplies an aggregate without a distinct rain amount.

Forecasts use the provider's hourly interval containing the estimated arrival time. Current precipitation values are modeled estimates, not necessarily direct observations. The risk thresholds use sustained wind speed, not gusts, and do not model freezing rain, hail, or road ice. Missing or ambiguous precipitation remains unavailable; a known No Travel threshold is still reported when other data is missing. Conditions can differ between sampled points and forecast intervals.

After selecting a route, choose **Follow trip** to show live position and accuracy, estimate progress and remaining time, and view upcoming forecast checkpoints. Browser location permission and a secure context such as HTTPS or localhost are required. Several accurate off-route fixes reveal **Replan from GPS**. **Navigate in Google Maps** hands remaining stops to Google Maps, which calculates its own route; if the trip exceeds the mobile Maps URL waypoint limit, the link opens directions to the next stop.

### Weather thresholds

| Risk | Wind | Rain | Snow |
| --- | --- | --- | --- |
| Moderate | From 25 mph | From 0.10 in/hr | From 0.50 in/hr |
| High | From 35 mph | From 0.25 in/hr | From 1.00 in/hr |
| Severe | From 45 mph | From 0.50 in/hr | From 2.00 in/hr |
| No Travel | From 55 mph | Above 1.00 in/hr | Above 3.00 in/hr |

Wind from 35 mph becomes Severe when the load exceeds 40,000 lb. Wind from 45 mph becomes No Travel when the load exceeds 30,000 lb. The highest risk from wind, rain, and snow is used.

## Tests and benchmarks

The regression tests use synthetic routes and forecasts and do not require live providers or Redis. Run the backend and frontend checks listed above after installing their dependencies.

The heatmap precomputes longitude distances, skips samples too far from a raster row, and uses one distance-weighted interpolation pass. In a local Node benchmark, median generation time for a 288 × 288 raster with 64 synthetic regional readings fell from 429 ms to 27 ms. This measures raster generation only.

Historical latency results, implementation details, and commands to reproduce the benchmark are in [docs/performance.md](docs/performance.md). Those results predate the Google Maps migration.

## Architecture

```text
React planner and Google Maps interface
              |
              v
      Vite / Nginx proxy
              |
              v
        Django API
          /     \
         v       v
 Google Maps    Redis + SQLite
 Platform       cache, limits, data
```

- `frontend/src/App.tsx` owns planner state and the route-planning interface.
- `frontend/src/GoogleMapSurface.tsx` renders the map and its overlays.
- `frontend/src/routeGeometry.ts`, `routeProgress.ts`, and `routeRecommendation.ts` handle browser-side route geometry, trip progress, and recommendations.
- `backend/routing/views.py` and `serializers.py` expose and validate API requests.
- `backend/routing/google_maps.py` adapts Google Maps Platform responses; `route_delivery.py` handles route delivery.
- `backend/routing/provider_cache.py` and `throttles.py` manage provider caching and API rate limits.

The browser requests `POST /api/route-plans?delivery=progressive`. NDJSON delivers ranked routes and the selected map first, followed by directions, alternate geometry, and forecast playback. The default endpoint also supports a full JSON response. Preserve `X-Accel-Buffering: no` through reverse proxies so the first event can reach the browser promptly.

## Vercel services

The root `vercel.json` defines two services in one Vercel project: `backend` (Django, rooted at `backend/`) and `frontend` (Vite, rooted at `frontend/`). The public `/api/*` path is routed to Django; all other paths are routed to the frontend, whose rewrite serves the Vite SPA for routes such as `/settings`. The API remains same-origin, so the browser does not call the backend service URL directly. No Vercel service bindings are needed: the frontend calls `/api/*` through the public rewrite, and Django calls external Google APIs and Redis rather than another Vercel service.

In Vercel, set the project Framework Preset to **Services** and keep the project root at the repository root. Services are currently in beta. Add these environment variables for Production and Preview as needed:

- `DJANGO_SECRET_KEY`: a random secret of at least 50 characters.
- `GOOGLE_MAPS_API_KEY`: server-side Routes, Places, Geocoding, and Weather key.
- `GOOGLE_MAPS_BROWSER_KEY`: browser key restricted to Maps JavaScript and your Vercel/custom-domain referrers.
- `DJANGO_ALLOWED_HOSTS`: comma-separated custom hostnames if you use a custom domain. Vercel deployment hostnames are read from Vercel's system variables.
- `REDIS_URL`: optional external Redis URL for shared provider caching and rate limits across serverless instances. Without it, Vercel uses a per-process memory cache; that cache is not shared between instances.

With the Vercel CLI installed, run `vercel dev --local` from the repository root to test the services together without cloud authentication. Check `/api/health`, an API request, and a frontend route such as `/settings` through the Vercel dev URL. Use `vercel dev` instead when working with a linked project and its environment.

Vercel is treated as the HTTPS edge, so the Kong-only `SPOTTER_GATEWAY_TOKEN` is not required there. Django still restricts browser API use to the same origin. SQLite remains the configured database and uses `/tmp/mapme.sqlite3` on Vercel because the function filesystem is ephemeral. This app currently stores no trip data in Django's database; SQLite there is only used for Django's database connectivity check. Do not rely on that SQLite file for persistent data.

No deployment is triggered by this repository configuration. Before importing the repository, confirm that Vercel Services is enabled for the account and configure the environment variables above.

## Kubernetes

```bash
docker compose build
kubectl apply -f k8s/
kubectl rollout status deployment/backend
kubectl rollout status deployment/frontend
kubectl rollout status deployment/kong
kubectl port-forward service/kong 10001:8000
```

Store both Google keys and the internal gateway token in the `truck-routing-secret` Secret. For private access, put `SPOTTER_GATEWAY_USERNAME` and `SPOTTER_GATEWAY_PASSWORD` in `spotter-gateway-secret`. Set the production settings in `truck-routing-config` before deploying publicly. Docker Desktop Kubernetes can use the local images. For a remote cluster, push the app and gateway-renderer images to a registry and update the manifests. Use a CNI that enforces NetworkPolicy. The bundled SQLite backend uses one replica.

These Kubernetes manifests are a starting template, not a public ingress setup: they use local image tags, set `DJANGO_ENVIRONMENT=local`, and expose only ClusterIP services. A public cluster needs registry image references, production Secrets and ConfigMaps, and an HTTPS ingress or TLS proxy that keeps Kong private.

## Production configuration

### Single-server deployment with Docker Compose

The included production profile runs Caddy as the public HTTPS edge and keeps Kong bound to loopback. Point the site's DNS `A` record (and `AAAA` record if used) to the server, allow inbound ports 80 and 443 in the host firewall, then prepare the production environment file:

```bash
cp .env.production.example .env.production
```

Set `SPOTTER_DOMAIN` and `DJANGO_ALLOWED_HOSTS` to the real hostname. Generate separate secrets for `DJANGO_SECRET_KEY` and `SPOTTER_GATEWAY_TOKEN`:

```bash
python3 -c 'import secrets; print(secrets.token_urlsafe(48))'
python3 -c 'import secrets; print(secrets.token_urlsafe(40))'
```

Generate the gateway password with `python3 -c 'import secrets; print(secrets.token_urlsafe(24))'`, then set it with a private gateway username. Add both Google keys, enable billing and the required APIs, and restrict them: the browser key to Maps JavaScript API and `https://your-domain/*`; the server key to Routes, Places API (New), Geocoding, and Weather, plus the server's outbound IP when stable. Keep `.env.production` in the deployment host's secret storage and out of version control.

The production template sets a fixed Caddy address with `SPOTTER_PROXY_IP` inside `SPOTTER_PROXY_SUBNET`. Kong trusts that address for the forwarded client IP and HTTPS scheme. Choose a subnet that does not overlap your server or VPC. If you already have a production environment file, set both variables and remove any stale `KONG_TRUSTED_IPS` override. Local Docker Compose leaves the subnet unset for Docker to allocate.

Build and start the production stack:

```bash
docker compose --env-file .env.production --profile production up -d --build --wait
```

Open `https://SPOTTER_DOMAIN` in a browser, substituting your hostname. Caddy obtains and renews the TLS certificate; keep ports 80 and 443 reachable for certificate issuance and renewal. The app prompts for the shared gateway credentials. This is shared site access, not individual accounts or roles. Kong and Django communicate over private Compose networks; do not publish the backend, Redis, or Kong's Admin API. Preserve the `backend_data`, `caddy_data`, and `caddy_config` volumes when updating or stopping the stack. Do not use `docker compose down --volumes` on a host with data you need.

SQLite stays on one backend replica in the persistent `backend_data` volume. Create a consistent online backup with:

```bash
SPOTTER_COMPOSE_ENV_FILE="$PWD/.env.production" scripts/backup-sqlite.sh
```

The script writes permission-restricted snapshots under `backups/` and keeps the most recent 14 days. Store encrypted copies off the server as well. To run it nightly, add a cron entry using absolute paths, for example:

```cron
17 2 * * * SPOTTER_COMPOSE_ENV_FILE=/srv/spotter/.env.production /srv/spotter/scripts/backup-sqlite.sh >> /var/log/spotter-sqlite-backup.log 2>&1
```

To update containers, use the same `--env-file` and `--profile production` options with `docker compose up -d --build --wait`. For a rollback, keep the previous image and a recent database backup. SQLite is suitable here for a single application replica; do not scale the backend horizontally.

### Production security model

Production requires private gateway access: the website and its API both prompt for the configured Basic Auth credentials. Django also checks Kong's shared internal token. Production startup rejects `SPOTTER_GATEWAY_ACCESS=public`. Kong accepts HTTP on its private network because TLS terminates at Caddy; Caddy redirects public HTTP to HTTPS and is the only service in the production profile with public ports. Kong trusts forwarded headers only from `KONG_TRUSTED_IPS`. Keep Kong private if you use another TLS terminator.

If you use an existing HTTPS proxy instead of the included Caddy service, preserve the requested `Host`, remove untrusted incoming forwarding headers, and supply the client address in `X-Forwarded-For` and scheme in `X-Forwarded-Proto`. Set `KONG_TRUSTED_IPS` to that proxy's exact address or narrow CIDR as seen by Kong. Kong connects to Django and Nginx over private deployment networks.

For example, this location block sits inside an Nginx HTTPS virtual host. Restrict access to the Kong listener to this proxy.

```nginx
location / {
    proxy_pass http://127.0.0.1:10001;
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_set_header Host $http_host;
    proxy_set_header Forwarded "";
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Forwarded-Proto https;
    proxy_set_header X-Forwarded-Host $http_host;
    proxy_set_header X-Forwarded-Port 443;
    proxy_set_header X-Forwarded-Path "";
    proxy_set_header X-Forwarded-Prefix "";
    proxy_set_header X-Real-IP $remote_addr;
    proxy_buffering off;
    proxy_read_timeout 60s;
    client_max_body_size 64k;
}
```

Supply these settings through your environment or secret store.

| Setting | Purpose |
| --- | --- |
| `DJANGO_ENVIRONMENT=production` | Requires HTTPS, disables debug and Django admin, and enables secure cookies. |
| `DJANGO_ALLOWED_HOSTS` | Public hostname or comma-separated hostnames. |
| `DJANGO_SECRET_KEY` | Stable Django signing secret. Generate it with `python3 -c 'import secrets; print(secrets.token_urlsafe(48))'`. |
| `SPOTTER_GATEWAY_TOKEN` | Shared internal secret for Kong and Django. Generate it with `python3 -c 'import secrets; print(secrets.token_urlsafe(40))'`. |
| `SPOTTER_GATEWAY_USERNAME` and `SPOTTER_GATEWAY_PASSWORD` | Login for the private site. Set a random password of at least 16 characters. The browser prompts for it over HTTPS. |
| `SPOTTER_GATEWAY_ACCESS` | Defaults to `private` in production and `public` locally. Production rejects `public`. |
| `GOOGLE_MAPS_API_KEY` and `GOOGLE_MAPS_BROWSER_KEY` | Google server and browser keys. Restrict them as shown above. |

Kong preserves streaming for the API. Use unbuffered proxying for progressive NDJSON at the TLS terminator. Kong and Django reject bodies larger than 64 KiB. The browser and API use the same origin, and the gateway leaves Kong’s Admin API and Manager disabled.

For Compose credential changes, run `docker compose --env-file .env.production --profile production up -d --force-recreate gateway-config backend kong https-proxy`. For Kubernetes, update the Secrets and restart the backend and Kong deployments. The gateway renders its configuration into memory as part of startup.

### Rate limits

Kong applies these limits per client IP using its own Redis instance. A request beyond the quota receives HTTP 429 with `Retry-After`. If gateway Redis is unavailable, the limited endpoints reject requests until it recovers.

| API group | Requests per minute | Requests per hour |
| --- | ---: | ---: |
| `/api/route-plans` and `/api/routes/plan` combined | 10 | 90 |
| Location search | 60 | 600 |
| Nearby search, place details, and photos combined | 30 | 180 |
| Weather heatmap | 30 | 300 |
| Health, readiness, and browser map configuration combined | 60 | 600 |

An edge burst limit also applies before authentication. Django retains per-client sliding windows of 150 API requests and 15 plans per minute. Set Maps Platform quotas separately to bound provider usage across clients.

## Current limitations

- Routes use Google's standard driving profile; truck clearance, axle limits, and other commercial restrictions require an appropriate truck-routing profile. Verify restrictions and advisories before dispatch.
- Country labels describe waypoints, not every border crossed along a route.
- Searches and planning send submitted locations to Google Maps Platform. Live trip tracking uses the browser's location and sends the current fix when the user chooses to replan; Google Maps receives data for the map area being viewed.
- Live location requires an active, visible page. Forecast coverage and playback depend on provider availability.
