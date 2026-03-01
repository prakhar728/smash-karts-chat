FROM rust:1.85-slim AS builder
WORKDIR /app

COPY Cargo.toml Cargo.lock ./
COPY src ./src
RUN cargo build --locked --release

FROM debian:bookworm-slim
RUN useradd --create-home --uid 10001 appuser
WORKDIR /app
COPY --from=builder /app/target/release/server /usr/local/bin/server

ENV BIND_ADDR=0.0.0.0:8080
ENV LOG_PATH=/app/game-traffic.log

EXPOSE 8080
USER appuser
CMD ["server"]
