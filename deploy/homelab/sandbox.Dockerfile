# Homelab sandbox: the upstream release sandbox image (NATS bridge, python toolchain),
# re-configured to run as uid 1000 (non-root).
#
# Based on the pinned upstream image (packages/trueforge-core/src/core/sandbox/sandboxImage.json)
# instead of rebuilt from scratch: the homelab's kubelet pulls large GHCR images very slowly
# (and serially, blocking other apps), while tfy.jfrog.io is fast — so the heavy layers come
# from JFrog and the GHCR layers built here stay a few KB.
FROM tfy.jfrog.io/tfy-images/trueforge-sandbox:0dab475d3d20a8333cff41f25f88e7134c424cf9

USER root
RUN groupadd --gid 1000 trueforge \
  && useradd --uid 1000 --gid 1000 --home-dir /home/trueforge --no-create-home --shell /bin/bash trueforge \
  && mkdir -p /home/trueforge /opt/tf/bin /opt/tf/uploads /opt/tf/skills /opt/tf/tool-results /opt/tf/mcp-client \
     /var/lib/nats /var/log/supervisor /var/run/supervisor \
  && chown -R 1000:1000 /home/trueforge /opt/tf /var/lib/nats /var/log/supervisor /var/run/supervisor

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
