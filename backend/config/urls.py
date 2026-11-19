from django.contrib import admin
from django.conf import settings
from django.urls import path

from routing.views import health_check, location_details, location_photos, map_weather_heatmap, maps_config, plan_routes, readiness_check, search_locations, search_nearby

urlpatterns = [
    path("api/health", health_check, name="health-check"),
    path("api/maps/config", maps_config, name="maps-config"),
    path("api/ready", readiness_check, name="readiness-check"),
    path("api/route-plans", plan_routes, name="route-plans"),
    path("api/routes/plan", plan_routes, name="plan-routes"),
    path("api/locations/search", search_locations, name="search-locations"),
    path("api/locations/details", location_details, name="location-details"),
    path("api/locations/photos", location_photos, name="location-photos"),
    path("api/locations/nearby", search_nearby, name="search-nearby"),
    path("api/weather/heatmap", map_weather_heatmap, name="map-weather-heatmap"),
]

if settings.ENABLE_ADMIN:
    urlpatterns += [path("admin/", admin.site.urls)]
