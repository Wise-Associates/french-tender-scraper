#!/usr/bin/env bash
# Deployment of the tender scraper on the VPS (ADR 0003, docs/deployment-vps.md). Installed on the server as
# /usr/local/bin/tender-scraper-deploy (owned by root); runs as the deploy user. Adapted from the veille's
# veille-deploy.sh (same security model on the shared server).
#
# Called by GitHub Actions over SSH, with a key limited to this command:
#   docker save french-tender-scraper:<commit> | gzip | ssh deploy@<vps> deploy <commit>
# By hand on the server:
#   sudo -u deploy tender-scraper-deploy status             version online, container, images kept
#   sudo -u deploy tender-scraper-deploy rollback <commit>  puts back a version whose image is still on the server
#   sudo -u deploy tender-scraper-deploy restart            restarts the online version (after editing scraper.env)
#   sudo -u deploy tender-scraper-deploy run                runs a scrape now and prints its result
#   sudo -u deploy tender-scraper-deploy session < file     installs a new Partenaire GC session (manual login)
# `run` and `session` are refused over SSH: GitHub's key can only deploy, roll back, restart and read the status.
set -euo pipefail

ROOT=${SCRAPER_ROOT:-/opt/french-tender-scraper}
REPO=$ROOT/repo
STATE=$ROOT/deployment
DATA=$ROOT/data
ENV_FILE=${SCRAPER_ENV_FILE:-/etc/french-tender-scraper/scraper.env}
LOG=$STATE/last-deployment.log
IMAGE=french-tender-scraper
CONTAINER=tender-scraper
# Container user, with no account on the server (deploy/compose.yml, Dockerfile): owns $DATA.
APP_USER=10001:10001
KEEP_IMAGES=5
# The image is about 2 GB uncompressed (Chromium); a bigger stream is cut, hence unreadable, hence refused.
MAX_ARCHIVE_BYTES=$((4 * 1024 * 1024 * 1024))
MAX_SESSION_BYTES=$((1024 * 1024))

log() { printf '[tender-scraper-deploy] %s\n' "$*" >&2; }
die() { log "FAILED: $*"; exit 1; }

# `sudo -u deploy …` keeps the admin's working directory, where deploy may not enter: docker compose then fails.
cd "$ROOT" || die "folder $ROOT missing or not readable by $(id -un)"

app_compose() { # commit arguments…
  IMAGE_TAG=$1 SCRAPER_ENV_FILE=$ENV_FILE SCRAPER_DATA=$DATA docker compose -p tender-scraper -f "$REPO/deploy/compose.yml" "${@:2}"
}

# Expected shape of the container (deploy/compose.yml): nothing more than what it says today. A compose.yml changed
# on main (privilege, server volume, port, host network, other user) is refused before anything starts.
# « docker compose config » copies the secrets of scraper.env into its output: only setting names are printed.
COMPOSE_CHECK=$(
  cat << 'PY'
import json, sys
data, image, user = sys.argv[1], sys.argv[2], sys.argv[3]
config = json.load(sys.stdin)
problems = []
extra = sorted(set(config) - {"name", "networks", "services"})
if extra:
    problems.append("extra sections: " + ", ".join(extra))
networks = config.get("networks") or {}
if set(networks) - {"default"} or set(networks.get("default") or {}) - {"name", "ipam"} or (networks.get("default") or {}).get("ipam") not in (None, {}):
    problems.append("networks: the default one only")
services = config.get("services") or {}
if set(services) != {"scraper"}:
    problems.append("services: « scraper » only")
service = services.get("scraper") or {}
allowed = {"cap_drop", "command", "container_name", "entrypoint", "environment", "healthcheck", "image", "init", "logging",
           "mem_limit", "networks", "pids_limit", "read_only", "restart", "security_opt", "shm_size", "stop_grace_period",
           "tmpfs", "user", "volumes"}
extra = sorted(set(service) - allowed)
if extra:
    problems.append("extra settings: " + ", ".join(extra))
expected = {"image": image, "user": user, "read_only": True, "cap_drop": ["ALL"], "security_opt": ["no-new-privileges:true"],
            "container_name": "tender-scraper", "init": True, "command": None, "entrypoint": None, "networks": {"default": None}}
for key, value in expected.items():
    if service.get(key) != value:
        problems.append(key + ": unexpected value")
volumes = service.get("volumes") or []
volume = volumes[0] if len(volumes) == 1 else {}
if (len(volumes) != 1 or set(volume) - {"type", "source", "target", "bind"} or volume.get("type") != "bind"
        or volume.get("source") != data or volume.get("target") != "/data" or volume.get("bind") not in (None, {}, {"create_host_path": True})):
    problems.append("volumes: the data folder only, on /data")
if any(not isinstance(entry, str) or not entry.startswith("/tmp:") for entry in service.get("tmpfs") or []):
    problems.append("tmpfs: /tmp only")
if problems:
    print("deploy/compose.yml refused — " + " ; ".join(problems), file=sys.stderr)
    sys.exit(1)
PY
)

# Archive sent by GitHub: one image, the announced one. « docker load » would otherwise give other images the names it
# contains, including the kept images of MyBestConsultant or the veille (a booby-trapped rollback).
ARCHIVE_CHECK=$(
  cat << 'PY'
import json, sys, tarfile
archive, image = sys.argv[1], sys.argv[2]
repository, tag = image.rsplit(":", 1)
def refuse(reason):
    print("archive refused — " + reason, file=sys.stderr)
    sys.exit(1)
try:
    with tarfile.open(archive) as tar:
        names = set(tar.getnames())
        read = lambda name: json.load(tar.extractfile(name))
        if "manifest.json" not in names:
            refuse("no manifest.json")
        manifest = read("manifest.json")
        if not isinstance(manifest, list) or len(manifest) != 1 or manifest[0].get("RepoTags") != [image]:
            refuse("manifest.json: one image, " + image)
        if "repositories" in names:
            repositories = read("repositories")
            if set(repositories) != {repository} or set(repositories[repository]) != {tag}:
                refuse("repositories: one image, " + image)
        if "index.json" in names:
            entries = read("index.json").get("manifests") or []
            if len(entries) != 1 or entries[0].get("mediaType") != "application/vnd.oci.image.manifest.v1+json":
                refuse("index.json: one image")
            annotations = entries[0].get("annotations") or {}
            if annotations.get("io.containerd.image.name") not in (None, "docker.io/library/" + image) or annotations.get("org.opencontainers.image.ref.name") not in (None, tag):
                refuse("index.json: one image, " + image)
except (tarfile.TarError, OSError, ValueError, KeyError, AttributeError) as error:
    refuse("unreadable (" + type(error).__name__ + ")")
PY
)

# A Playwright storage state holding Partenaire GC cookies only (src/cli/login-session.ts writes it that way).
SESSION_CHECK=$(
  cat << 'PY'
import json, sys
try:
    state = json.load(sys.stdin)
    cookies = state["cookies"]
    assert isinstance(cookies, list) and cookies, "no cookie"
    for cookie in cookies:
        domain = cookie["domain"].lstrip(".")
        assert domain == "partenaire-gc.com" or domain.endswith(".partenaire-gc.com"), "cookie of another site: " + domain
    assert isinstance(state.get("origins", []), list), "origins: not a list"
except (ValueError, KeyError, TypeError, AssertionError) as error:
    print("session refused — " + str(error or type(error).__name__), file=sys.stderr)
    sys.exit(1)
PY
)

start_version() { # commit [up arguments…]
  app_compose "$1" config --format json | python3 -I -c "$COMPOSE_CHECK" "$DATA" "$IMAGE:$1" "$APP_USER" || return 1
  app_compose "$1" up --detach --wait --wait-timeout 120 "${@:2}"
}

show_status() {
  if [[ -f $STATE/active-commit ]]; then log "online: commit $(<"$STATE/active-commit")"; else log "no version deployed"; fi
  docker ps --all --filter "name=^$CONTAINER\$" --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}'
  log "images on the server (rollback possible):"
  docker image ls "$IMAGE" --format '  {{.Tag}}  {{.CreatedSince}}'
  log "log of the last deployment: $LOG"
}

# Over SSH, the requested command arrives in SSH_ORIGINAL_COMMAND (key limited by command= in authorized_keys).
over_ssh=false
[[ -n ${SSH_ORIGINAL_COMMAND:-} ]] && over_ssh=true
read -r -a args <<< "${SSH_ORIGINAL_COMMAND:-$*}"
action=${args[0]:-}
argument=${args[1]:-}
case $action in
  status)
    show_status
    exit 0
    ;;
  restart)
    [[ ${#args[@]} -eq 1 ]] || die "usage: restart"
    ;;
  run | session)
    [[ ${#args[@]} -eq 1 ]] || die "usage: $action"
    [[ $over_ssh == false ]] || die "$action is only allowed on the server (sudo -u deploy tender-scraper-deploy $action)"
    ;;
  deploy | rollback)
    [[ ${#args[@]} -eq 2 && $argument =~ ^[0-9a-f]{40}$ ]] || die "usage: $action <full 40-character commit>"
    ;;
  *)
    die "usage: deploy <commit> | rollback <commit> | restart | run | session | status"
    ;;
esac

if [[ $action == run ]]; then
  # A scrape can take several minutes: node's http client has no timeout (fetch would give up after 5 minutes).
  exec docker exec "$CONTAINER" node -e "
    const req = require('http').request(
      { host: '127.0.0.1', port: 3000, path: '/api/scrape/run', method: 'POST', headers: { 'content-type': 'application/json' } },
      (res) => { let body = ''; res.on('data', (c) => (body += c)); res.on('end', () => { console.log(body); process.exit(res.statusCode < 300 ? 0 : 1); }); });
    req.on('error', (e) => { console.error(e.message); process.exit(1); });
    req.end('{}');"
fi

if [[ $action == session ]]; then
  [[ -f $STATE/active-commit ]] || die "no version deployed"
  mkdir -p "$STATE"
  session=$(mktemp "$STATE/session.XXXXXX")
  trap 'rm -f "$session"' EXIT
  head -c "$MAX_SESSION_BYTES" > "$session"
  python3 -I -c "$SESSION_CHECK" < "$session" || die "nothing installed"
  # Written by the container's user, without network: the file belongs to it and is readable by it only.
  docker run --rm -i --network none --read-only --cap-drop ALL --security-opt no-new-privileges:true --user "$APP_USER" \
    -v "$DATA:/data" --entrypoint sh "$IMAGE:$(<"$STATE/active-commit")" \
    -c 'umask 077 && mkdir -p /data/sessions && cat > /data/sessions/partenaire-gc.json.tmp && mv -f /data/sessions/partenaire-gc.json.tmp /data/sessions/partenaire-gc.json' \
    < "$session" || die "the session could not be written"
  log "Partenaire GC session installed; the next run uses it"
  exit 0
fi

[[ -r $ENV_FILE ]] || die "secrets file $ENV_FILE missing or not readable by $(id -un) (guide, part 2)"
[[ -d $DATA ]] || die "data folder $DATA missing (guide, part 2)"
mkdir -p "$STATE"
exec 9> "$STATE/deploy.lock"
flock -n 9 || die "another deployment is in progress"
# If the SSH connection drops, the deployment still finishes: hang-up ignored, output copied to $LOG by tee.
trap '' HUP PIPE
exec > >(tee -p "$LOG" >&2) 2>&1

previous_commit=""
if [[ -f $STATE/active-commit ]]; then previous_commit=$(<"$STATE/active-commit"); fi

if [[ $action == restart ]]; then
  [[ -n $previous_commit ]] || die "no version deployed"
  log "restarting version $previous_commit (secrets file read again)"
  start_version "$previous_commit" --force-recreate || die "the version does not restart: docker logs $CONTAINER"
  log "done"
  exit 0
fi

commit=$argument
# The announced commit must be on main (checked before reading the image).
git -C "$REPO" fetch --quiet origin main || die "cannot read GitHub (repository deploy key?)"
git -C "$REPO" merge-base --is-ancestor "$commit" origin/main || die "commit $commit is not on the main branch"

image=$IMAGE:$commit
if [[ $action == deploy ]]; then
  archive=$(mktemp "$STATE/image.XXXXXX.tar")
  if ! gunzip | head -c "$MAX_ARCHIVE_BYTES" > "$archive"; then
    rm -f "$archive"
    die "unreadable image stream"
  fi
  if ! python3 -I -c "$ARCHIVE_CHECK" "$archive" "$image"; then
    rm -f "$archive"
    die "archive refused: only image $image is accepted (nothing was loaded)"
  fi
  log "loading image $image"
  loaded=$(docker load --input "$archive") || {
    rm -f "$archive"
    die "the image could not be loaded"
  }
  rm -f "$archive"
  [[ $loaded == "Loaded image: $image" ]] || die "unexpected load: ${loaded//$'\n'/ ; }"
fi
docker image inspect "$image" > /dev/null 2>&1 || die "image $image not on the server"

log "deployment files of commit $commit"
git -C "$REPO" checkout --quiet --detach "$commit"
if ! cmp -s "${BASH_SOURCE[0]}" "$REPO/deploy/tender-scraper-deploy.sh"; then
  log "WARNING: deploy/tender-scraper-deploy.sh differs from the installed copy; reinstall it (guide, part 5)"
fi

log "starting version $commit"
if ! start_version "$commit"; then
  log "logs of version $commit:"
  docker logs --tail 80 "$CONTAINER" || log "(no container, or unreadable logs)"
  if [[ -z $previous_commit ]]; then
    app_compose "$commit" down || log "the container could not be removed: docker rm -f $CONTAINER"
    git -C "$REPO" checkout --quiet --detach origin/main
    die "version $commit does not start; no previous version"
  fi
  log "putting back previous version $previous_commit"
  git -C "$REPO" checkout --quiet --detach "$previous_commit"
  start_version "$previous_commit" || log "WARNING: the previous version does not restart either: docker logs $CONTAINER"
  die "version $commit does not start; previous version put back"
fi
printf '%s\n' "$commit" > "$STATE/active-commit.new"
mv "$STATE/active-commit.new" "$STATE/active-commit"

mapfile -t old_tags < <(docker image ls "$IMAGE" --format '{{.CreatedAt}}\t{{.Tag}}' | sort -r | cut -f2 | tail -n +$((KEEP_IMAGES + 1)))
for tag in "${old_tags[@]}"; do
  [[ $tag == "$commit" ]] && continue
  docker image rm "$IMAGE:$tag" > /dev/null || log "image $IMAGE:$tag not removed (watch disk space)"
done
log "done: version $commit online"
