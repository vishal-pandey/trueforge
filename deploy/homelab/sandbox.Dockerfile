# Homelab sandbox: upstream release sandbox toolchain, run as uid 1000 (non-root).
FROM python:3.13-slim-bookworm

ENV DEBIAN_FRONTEND=noninteractive
ARG NATS_SERVER_VERSION="v2.14.2"
ARG HELM_VERSION="v4.2.3"

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl git jq ripgrep supervisor tree unzip zip procps \
  && curl -fsSL https://get.helm.sh/helm-${HELM_VERSION}-linux-amd64.tar.gz | tar -xz -C /tmp \
  && mv /tmp/linux-amd64/helm /usr/local/bin/helm && rm -rf /tmp/linux-amd64 \
  && curl -fsSL https://github.com/nats-io/nats-server/releases/download/${NATS_SERVER_VERSION}/nats-server-${NATS_SERVER_VERSION}-linux-amd64.tar.gz | tar -xz -C /tmp \
  && mv /tmp/nats-server-${NATS_SERVER_VERSION}-linux-amd64/nats-server /usr/local/bin/nats-server \
  && rm -rf /tmp/nats-server-* \
  && python -m pip install --no-cache-dir --upgrade pip \
  && python -m pip install --no-cache-dir \
     aiohttp==3.14.1 genson==1.3.0 mcp==1.29.0 nats-py==2.15.0 openpyxl==3.1.5 pandas==3.0.5 pydantic==2.12.5 requests==2.33.1 \
  && rm -rf /var/lib/apt/lists/*

RUN groupadd --gid 1000 trueforge \
  && useradd --uid 1000 --gid 1000 --home-dir /home/trueforge --create-home --shell /bin/bash trueforge \
  && mkdir -p /opt/tf/bin /opt/tf/uploads /opt/tf/skills /opt/tf/tool-results /opt/tf/mcp-client /var/lib/nats /var/log/supervisor /var/run/supervisor \
  && chown -R 1000:1000 /opt/tf /var/lib/nats /var/log/supervisor /var/run/supervisor /home/trueforge

COPY packages/trueforge-core/scripts/sandbox/nats.conf /var/lib/nats/nats.conf
COPY deploy/homelab/supervisord.conf /etc/supervisor/supervisord.conf
COPY deploy/homelab/nats.supervisor.conf /etc/supervisor/conf.d/nats.conf

USER 1000:1000
ENV HOME=/home/trueforge \
    PATH=/opt/tf/bin:/home/trueforge/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    PIP_USER=1
RUN git config --global user.email "trueforge@example.org" && git config --global user.name "TrueForge Agent"
WORKDIR /home/trueforge
EXPOSE 4444
ENTRYPOINT ["/usr/bin/supervisord", "-n", "-c", "/etc/supervisor/supervisord.conf"]
