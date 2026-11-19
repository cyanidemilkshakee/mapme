FROM python:3.12-alpine
ENV PYTHONDONTWRITEBYTECODE=1
COPY render.py /app/render.py
ENTRYPOINT ["python", "/app/render.py", "/gateway-config/kong.json"]
