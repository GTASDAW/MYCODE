#!/usr/bin/env bash
set -euo pipefail

readonly baseline_sha=ccfb35f04432d9b9d54996b84be3832ac55773f9
readonly comparison_dir=.runtime/ci/comparison
readonly archive_dir=.runtime/query-baseline-source
readonly compose_files=( -f compose.yaml -f .github/compose.ci.yaml -f .github/compose.perf-ci.yaml -f .github/compose.comparison-ci.yaml )

[[ "${COMPOSE_PROJECT_NAME:-}" == gather-perf-ci && "${MYSQL_DATABASE:-}" == activity_platform_perf ]] || {
  echo 'Comparison requires the isolated gather-perf-ci project and activity_platform_perf database.' >&2
  exit 1
}
[[ "${PERF_EXPERIMENT_ID:-}" =~ ^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$ ]] || {
  echo 'Set a bounded experiment identity.' >&2
  exit 1
}
readonly candidate_sha="${PERF_CANDIDATE_SHA:-${GITHUB_SHA:-}}"
[[ "$candidate_sha" =~ ^[0-9a-f]{40}$ ]] || { echo 'An exact candidate source revision is required.' >&2; exit 1; }
readonly baseline_image="gather-query-baseline:$baseline_sha"
readonly candidate_image="gather-query-candidate:$candidate_sha"
export PERF_BACKEND_IMAGE="${PERF_BACKEND_IMAGE:-$baseline_image}"
export PERF_CURRENT_SHA="$candidate_sha"
export GITHUB_SHA="${GITHUB_SHA:-$candidate_sha}"

compose() { docker compose "${compose_files[@]}" "$@"; }

if [[ "${1:-}" == cleanup ]]; then
  # A failed preflight never grants ownership of an already-existing project.
  [[ -f "$comparison_dir/stack-owned" ]] || exit 0
  [[ "$(cat "$comparison_dir/stack-owned")" == "$PERF_EXPERIMENT_ID" ]] || { echo 'Cleanup experiment identity changed.' >&2; exit 1; }
  containers=$(docker ps -aq --filter label=com.docker.compose.project=gather-perf-ci)
  while IFS= read -r container; do
    [[ -z "$container" ]] && continue
    owner=$(docker inspect --format '{{index .Config.Labels "io.gather.query-experiment"}}' "$container")
    [[ "$owner" == "$PERF_EXPERIMENT_ID" ]] || { echo 'A foreign container joined the project; cleanup refused.' >&2; exit 1; }
  done <<< "$containers"
  volumes=$(docker volume ls -q --filter label=com.docker.compose.project=gather-perf-ci)
  while IFS= read -r volume; do
    [[ -z "$volume" ]] && continue
    owner=$(docker volume inspect --format '{{index .Labels "io.gather.query-experiment"}}' "$volume")
    [[ "$owner" == "$PERF_EXPERIMENT_ID" ]] || { echo 'A foreign volume joined the project; cleanup refused.' >&2; exit 1; }
  done <<< "$volumes"
  compose down --volumes --remove-orphans
  exit 0
fi
[[ $# == 0 ]] || { echo 'Unexpected comparison command.' >&2; exit 1; }
[[ "$(git rev-parse HEAD)" == "$candidate_sha" ]] || { echo 'Candidate checkout differs from its measured revision.' >&2; exit 1; }
# The historical experiment measures the V2 three-column locking projection.
# Later schema/business changes need a separate comparison contract, not a silently mixed claim.
readonly experiment_candidate_sha=d781648d7d9036b653a80e3082b609358a59df35
git cat-file -e "$experiment_candidate_sha^{commit}"
git diff --quiet "$experiment_candidate_sha" "$candidate_sha" -- backend/src/main/resources/db/migration backend/src/main/java/com/example/gather/mapper/ActivityMapper.java backend/src/main/java/com/example/gather/service/RegistrationService.java || {
  echo 'This historical comparison requires its V2 schema and locking projection. Reproduce it from d781648; later lifecycle changes need a new experiment.' >&2
  exit 1
}
git diff --quiet HEAD -- backend frontend scripts .github package.json package-lock.json || {
  echo 'Measured source has uncommitted changes.' >&2
  exit 1
}
[[ -z "$(git ls-files --others --exclude-standard -- backend frontend scripts .github)" ]] || {
  echo 'Untracked measured source differs from the declared revision.' >&2
  exit 1
}
[[ -z "$(docker ps -aq --filter label=com.docker.compose.project=gather-perf-ci)" &&
   -z "$(docker volume ls -q --filter label=com.docker.compose.project=gather-perf-ci)" ]] || {
  echo 'Use a fresh isolated project; existing containers or volumes will not be reset.' >&2
  exit 1
}
[[ ! -e "$comparison_dir/stack-owned" && ! -e "$archive_dir" ]] || { echo 'An earlier experiment directory exists; preserve it and use a fresh checkout.' >&2; exit 1; }
mkdir -p "$comparison_dir" "$archive_dir"
git cat-file -e "$baseline_sha^{commit}"
git archive "$baseline_sha" backend | tar -x -C "$archive_dir"
docker build --label "org.opencontainers.image.revision=$baseline_sha" --tag "$baseline_image" "$archive_dir/backend" 2>&1 | tee "$comparison_dir/build-baseline.log"
docker build --label "org.opencontainers.image.revision=$candidate_sha" --tag "$candidate_image" backend 2>&1 | tee "$comparison_dir/build-candidate.log"
compose build web 2>&1 | tee "$comparison_dir/build-web.log"
compose config --quiet
# Record creation intent before up so partial starts can be cleaned by exact labels.
printf '%s\n' "$PERF_EXPERIMENT_ID" > "$comparison_dir/stack-owned"
compose up -d --no-build --wait --wait-timeout 180 mysql 2>&1 | tee "$comparison_dir/start.log"

for phase in A1 B1 B2 A2; do
  export PERF_COMPARISON_PHASE="$phase"
  if [[ "$phase" == A* ]]; then
    export PERF_APP_SHA="$baseline_sha" PERF_BACKEND_IMAGE="$baseline_image"
  else
    export PERF_APP_SHA="$candidate_sha" PERF_BACKEND_IMAGE="$candidate_image"
  fi
  mkdir -p "$comparison_dir/$phase"
  # Recreate even B1 -> B2: every phase starts with a fresh JVM and Session state.
  compose up -d --no-build --no-deps --force-recreate backend 2>&1 | tee "$comparison_dir/$phase/start.log"
  if [[ "$phase" == A1 ]]; then
    compose up -d --no-build --no-deps web >> "$comparison_dir/$phase/start.log" 2>&1
  fi
  # Nginx resolves backend DNS at startup; refresh it after a container replacement.
  compose restart web >> "$comparison_dir/$phase/start.log" 2>&1
  compose exec -T backend java -version > "$comparison_dir/$phase/java-version.log" 2>&1
  export PERF_JAVA_VERSION
  PERF_JAVA_VERSION=$(head -n 1 "$comparison_dir/$phase/java-version.log")
  node scripts/performance-check.mjs 2>&1 | tee "$comparison_dir/$phase/run.log"
  compose logs --no-color backend > "$comparison_dir/$phase/backend.log" 2>&1
done
node scripts/performance-compare.mjs
if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
  cat "$comparison_dir/comparison.md" >> "$GITHUB_STEP_SUMMARY"
fi
