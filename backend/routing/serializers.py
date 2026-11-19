from rest_framework import serializers


MAX_STOPS = 5


class CoordinateInputSerializer(serializers.Serializer):
    lat = serializers.FloatField(min_value=-90, max_value=90)
    lon = serializers.FloatField(min_value=-180, max_value=180)
    label = serializers.CharField(required=False, allow_blank=True, max_length=300)
    country = serializers.CharField(required=False, allow_blank=True, max_length=100)


class TripStopInputSerializer(serializers.Serializer):
    label = serializers.CharField(required=False, allow_blank=True, max_length=500)
    country = serializers.CharField(required=False, allow_blank=True, max_length=100)
    coordinates = CoordinateInputSerializer(required=False)
    lat = serializers.FloatField(required=False, min_value=-90, max_value=90)
    lon = serializers.FloatField(required=False, min_value=-180, max_value=180)

    def validate(self, attrs):
        has_lat = "lat" in attrs
        has_lon = "lon" in attrs
        if has_lat != has_lon:
            raise serializers.ValidationError("Supply both latitude and longitude for a stop.")
        if not (attrs.get("coordinates") or has_lat or attrs.get("label")):
            raise serializers.ValidationError("Choose a location for every destination and stop.")
        return attrs


class RoutePlanInputSerializer(serializers.Serializer):
    origin = serializers.CharField(required=False, allow_blank=True, max_length=500)
    origin_label = serializers.CharField(required=False, allow_blank=True, max_length=500)
    origin_coordinates = CoordinateInputSerializer(required=False, allow_null=True)
    destination = serializers.CharField(required=False, allow_blank=True, max_length=500)
    destination_label = serializers.CharField(required=False, allow_blank=True, max_length=500)
    destination_coordinates = CoordinateInputSerializer(required=False, allow_null=True)
    stops = TripStopInputSerializer(many=True, required=False, allow_empty=False, max_length=MAX_STOPS)
    departure_time = serializers.CharField(required=False, allow_blank=True, allow_null=True, max_length=64)
    requested_time = serializers.CharField(required=False, allow_blank=True, allow_null=True, max_length=64)
    time_mode = serializers.ChoiceField(choices=("departure", "arrival"), required=False, default="departure")
    load_weight_lb = serializers.IntegerField(required=False, min_value=0, max_value=200000)
    checkpoint_interval_miles = serializers.FloatField(required=False, min_value=1, max_value=50)
