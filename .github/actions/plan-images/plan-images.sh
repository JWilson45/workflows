#!/usr/bin/env bash
set -euo pipefail

images_file="$(mktemp)"
printf '%s' "$IMAGES_JSON" > "$images_file"
jq -e 'type == "array" and length > 0' "$images_file" >/dev/null

multi_product=false
products_file="$(mktemp)"
if [ -n "${PRODUCTS_JSON// }" ]; then
  printf '%s' "$PRODUCTS_JSON" > "$products_file"
  jq -e 'type == "array" and length > 0' "$products_file" >/dev/null
  multi_product=true
else
  if [ -z "${HELM_RELEASE:-}" ] || [ -z "${KUBE_NAMESPACE:-}" ] || [ -z "${HELM_CHART:-}" ] || [ -z "${HELM_VALUES_FILE:-}" ]; then
    echo "Single-product mode requires helm_release, kube_namespace, helm_chart, and helm_values_file (or provide products_json)." >&2
    exit 1
  fi
  printf '[]' > "$products_file"
fi

pr_number="${PR_NUMBER:-}"
source_ref="${GITHUB_SHA}"
if [ "${GITHUB_EVENT_NAME}" = "pull_request" ] && [ "${GITHUB_EVENT_ACTION:-}" = "closed" ] && [ -n "${PR_MERGE_SHA:-}" ]; then
  source_ref="${PR_MERGE_SHA:-}"
fi
cache_pr_number="$pr_number"
is_open_pr_context=false
if [ "${GITHUB_EVENT_NAME}" = "pull_request" ] && [ "${GITHUB_EVENT_ACTION:-}" != "closed" ]; then
  is_open_pr_context=true
fi
if [ -z "$cache_pr_number" ] && [ "${GITHUB_EVENT_NAME}" = "push" ]; then
  associated_prs_json="$(curl -fsSL \
    -H "Authorization: Bearer $GH_TOKEN" \
    -H "Accept: application/vnd.github.groot-preview+json" \
    "https://api.github.com/repos/${GITHUB_REPOSITORY}/commits/${GITHUB_SHA}/pulls" || true)"
  if [ -n "$associated_prs_json" ]; then
    cache_pr_number="$(jq -r 'if type == "array" then [.[] | select(.merged_at != null)] | sort_by(.number) | last | .number // empty else empty end' <<< "$associated_prs_json")"
  fi
fi
short_sha="$(echo "$GITHUB_SHA" | cut -c1-7)"
build_matrix='[]'
image_meta='{}'
helm_set_args=''

# Reuse one pull token per registry repo across check_tag calls (avoids
# anonymous GHCR token minting + rate limits on multi-image plans).
REGISTRY_TOKEN_CACHE_DIR="$(mktemp -d)"

get_registry_pull_token() {
  local image="$1"
  local registry repo cache_key cache_file token_url token
  registry="$(echo "$image" | cut -d'/' -f1)"
  repo="$(echo "$image" | cut -d'/' -f2-)"
  if [ -z "$registry" ] || [ -z "$repo" ] || [ "$registry" = "$image" ]; then
    echo "image must be a full image reference like ghcr.io/org/repo. Got: $image" >&2
    return 1
  fi
  cache_key="$(printf '%s' "${registry}/${repo}" | tr '/:' '__')"
  cache_file="${REGISTRY_TOKEN_CACHE_DIR}/${cache_key}"
  if [ -s "$cache_file" ]; then
    cat "$cache_file"
    return 0
  fi

  if [ "$registry" = "ghcr.io" ]; then
    # Authenticated GHCR pull token via GITHUB_TOKEN (higher rate limits).
    token_url="https://${registry}/token?service=${registry}&scope=repository:${repo}:pull"
    token="$(curl -fsSL -u "${GH_ACTOR}:${GH_TOKEN}" "$token_url" | jq -r '.token // empty')"
  else
    # Best-effort anonymous token for non-GHCR registries.
    token_url="https://${registry}/token?scope=repository:${repo}:pull"
    token="$(curl -fsSL "$token_url" | jq -r '.token // empty' || true)"
  fi

  if [ -z "$token" ] || [ "$token" = "null" ]; then
    echo "Failed to obtain registry pull token for ${registry}/${repo}" >&2
    return 1
  fi
  printf '%s' "$token" > "$cache_file"
  printf '%s' "$token"
}

check_tag() {
  local image="$1"
  local tag="$2"
  local registry repo token status
  registry="$(echo "$image" | cut -d'/' -f1)"
  repo="$(echo "$image" | cut -d'/' -f2-)"
  if [ -z "$registry" ] || [ -z "$repo" ] || [ "$registry" = "$image" ]; then
    echo "image must be a full image reference like ghcr.io/org/repo. Got: $image" >&2
    exit 1
  fi
  token="$(get_registry_pull_token "$image")" || return 1
  status="$(curl -s -o /dev/null -w "%{http_code}" \
    -H "Authorization: Bearer $token" \
    -H "Accept: application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json" \
    "https://$registry/v2/$repo/manifests/$tag")"
  [ "$status" = "200" ]
}

append_cache_from() {
  local current="$1"
  local ref="$2"
  if [ -z "$current" ]; then
    printf 'type=registry,ref=%s' "$ref"
  else
    printf '%s\n%s' "$current" "type=registry,ref=$ref"
  fi
}

while IFS= read -r image_config; do
  name="$(jq -r '.name // empty' <<< "$image_config")"
  image="$(jq -r '.image // empty' <<< "$image_config")"
  app_dir="$(jq -r '.appDir // empty' <<< "$image_config")"
  docker_target="$(jq -r '.dockerTarget // empty' <<< "$image_config")"
  docker_context="$(jq -r '.context // "."' <<< "$image_config")"
  dockerfile="$(jq -r '.dockerfile // "Dockerfile"' <<< "$image_config")"
  helm_tag_path="$(jq -r '.helmTagPath // empty' <<< "$image_config")"

  if [ -z "$name" ] || [ -z "$image" ] || [ -z "$app_dir" ] || [ -z "$docker_target" ]; then
    echo "Each image entry requires name, image, appDir, and dockerTarget." >&2
    echo "$image_config" >&2
    exit 1
  fi
  if [ "$multi_product" != "true" ] && [ -z "$helm_tag_path" ]; then
    echo "Single-product mode requires helmTagPath on each image entry." >&2
    exit 1
  fi

  registry="$(echo "$image" | cut -d'/' -f1)"
  package_json="$(curl -fsSL \
    -H "Authorization: Bearer $GH_TOKEN" \
    -H "Accept: application/vnd.github.raw" \
    "https://api.github.com/repos/${GITHUB_REPOSITORY}/contents/$app_dir/package.json?ref=$source_ref")"
  version="$(jq -r '.version' <<< "$package_json")"

  if [ "$is_open_pr_context" = "true" ]; then
    image_tag="${version}-pr${pr_number}-${short_sha}"
  else
    image_tag="$version"
  fi

  tags="$image:$image_tag"
  if [ "$is_open_pr_context" != "true" ]; then
    tags="${tags}"$'\n'"$image:latest"
  fi
  cache_tag="$(printf '%s' "$docker_target" | tr -c 'A-Za-z0-9_.-' '-')"
  cache_ref="$image:buildcache-$cache_tag"
  # Shared monorepo deps cache across image names (same Dockerfile deps stage).
  owner_segment="$(echo "$image" | cut -d'/' -f2)"
  shared_deps_image="${registry}/${owner_segment}/mm-buildcache"
  shared_deps_ref="${shared_deps_image}:deps"
  cache_from=""
  cache_to_lines=("type=registry,ref=$cache_ref,mode=max")
  if [ -n "$cache_pr_number" ]; then
    pr_cache_ref="$image:buildcache-$cache_tag-pr$cache_pr_number"
    if check_tag "$image" "buildcache-$cache_tag-pr$cache_pr_number"; then
      cache_from="$(append_cache_from "$cache_from" "$pr_cache_ref")"
    fi
    if [ "$is_open_pr_context" = "true" ]; then
      cache_to_lines=("type=registry,ref=$pr_cache_ref,mode=max")
      cache_to_lines+=("type=registry,ref=${shared_deps_image}:deps-pr${cache_pr_number},mode=max")
    else
      cache_to_lines+=("type=registry,ref=${shared_deps_ref},mode=max")
    fi
  else
    cache_to_lines+=("type=registry,ref=${shared_deps_ref},mode=max")
  fi
  if [ -n "$cache_pr_number" ] && check_tag "$shared_deps_image" "deps-pr${cache_pr_number}"; then
    cache_from="$(append_cache_from "$cache_from" "${shared_deps_image}:deps-pr${cache_pr_number}")"
  fi
  if check_tag "$shared_deps_image" "deps"; then
    cache_from="$(append_cache_from "$cache_from" "$shared_deps_ref")"
  fi
  if check_tag "$image" "buildcache-$cache_tag"; then
    cache_from="$(append_cache_from "$cache_from" "$cache_ref")"
  fi
  cache_to="$(printf '%s\n' "${cache_to_lines[@]}")"

  if ! check_tag "$image" "$image_tag"; then
    matrix_item="$(jq -cn \
      --arg name "$name" \
      --arg image "$image" \
      --arg registry "$registry" \
      --arg dockerTarget "$docker_target" \
      --arg dockerContext "$docker_context" \
      --arg dockerfile "$dockerfile" \
      --arg tags "$tags" \
      --arg cacheFrom "$cache_from" \
      --arg cacheTo "$cache_to" \
      '{name:$name,image:$image,registry:$registry,dockerTarget:$dockerTarget,dockerContext:$dockerContext,dockerfile:$dockerfile,tags:$tags,cacheFrom:$cacheFrom,cacheTo:$cacheTo}')"
    build_matrix="$(jq -c --argjson item "$matrix_item" '. + [$item]' <<< "$build_matrix")"
  fi

  image_meta="$(jq -c \
    --arg name "$name" \
    --arg tag "$image_tag" \
    --arg helmTagPath "$helm_tag_path" \
    '.[$name] = {tag:$tag, helmTagPath:$helmTagPath}' <<< "$image_meta")"

  if [ -n "$helm_tag_path" ]; then
    if [ -n "$helm_set_args" ]; then
      helm_set_args="${helm_set_args},"
    fi
    helm_set_args="${helm_set_args}${helm_tag_path}=${image_tag}"
  fi
done < <(jq -c '.[]' "$images_file")

products_plan='[]'
if [ "$multi_product" = "true" ]; then
  while IFS= read -r product_config; do
    product_name="$(jq -r '.name // empty' <<< "$product_config")"
    do_product_deploy="$(jq -r 'if has("do_deploy") then (.do_deploy|tostring) else "true" end' <<< "$product_config")"
    image_names="$(jq -c '.image_names // []' <<< "$product_config")"
    if [ -z "$product_name" ]; then
      echo "Each product entry requires name." >&2
      exit 1
    fi
    if [ "$(jq 'length' <<< "$image_names")" -eq 0 ]; then
      echo "Product $product_name requires image_names." >&2
      exit 1
    fi

    product_helm_set=''
    while IFS= read -r img_name; do
      [ -z "$img_name" ] && continue
      meta="$(jq -c --arg n "$img_name" '.[$n] // empty' <<< "$image_meta")"
      if [ -z "$meta" ] || [ "$meta" = "null" ]; then
        echo "Product $product_name references unknown image_name: $img_name" >&2
        exit 1
      fi
      tag="$(jq -r '.tag' <<< "$meta")"
      path="$(jq -r '.helmTagPath // empty' <<< "$meta")"
      # Prefer per-product helm tag path override map when present
      override="$(jq -r --arg n "$img_name" '.helm_tag_paths[$n] // empty' <<< "$product_config")"
      if [ -n "$override" ]; then
        path="$override"
      fi
      if [ -z "$path" ]; then
        echo "No helmTagPath for image $img_name (product $product_name)." >&2
        exit 1
      fi
      if [ -n "$product_helm_set" ]; then
        product_helm_set="${product_helm_set},"
      fi
      product_helm_set="${product_helm_set}${path}=${tag}"
    done < <(jq -r '.[]' <<< "$image_names")

    if [ "$do_product_deploy" != "true" ]; then
      echo "Product $product_name is build-only (do_deploy=false); skipping deploy plan entry."
      continue
    fi

    planned="$(jq -cn \
      --argjson base "$product_config" \
      --arg helm_set_args "$product_helm_set" \
      '$base + {helm_set_args:$helm_set_args} | del(.image_names, .helm_tag_paths)')"
    products_plan="$(jq -c --argjson item "$planned" '. + [$item]' <<< "$products_plan")"
  done < <(jq -c '.[]' "$products_file")
fi

should_build=false
if [ "$(jq 'length' <<< "$build_matrix")" -gt 0 ]; then
  should_build=true
fi

# Deploy is independent of whether any image needs a rebuild. Callers that
# split build/deploy (or only change helm values) still need GitOps updates
# when tags already exist. No-op tag writes are harmless: the GitOps step
# skips the commit when the Application files are unchanged.
should_deploy=false
if [ "${DO_DEPLOY}" = "true" ]; then
  if [ "$multi_product" = "true" ]; then
    if [ "$(jq 'length' <<< "$products_plan")" -gt 0 ]; then
      should_deploy=true
    fi
  elif [ -n "$helm_set_args" ]; then
    should_deploy=true
  fi
fi

echo "multi_product=$multi_product"
echo "should_build=$should_build"
echo "should_deploy=$should_deploy"
echo "images to build: $(jq -c '[.[].name]' <<< "$build_matrix")"
echo "products to deploy: $(jq -c '[.[].name]' <<< "$products_plan")"

{
  echo "build_matrix=$build_matrix"
  echo "helm_set_args=$helm_set_args"
  echo "multi_product=$multi_product"
  echo "should_build=$should_build"
  echo "should_deploy=$should_deploy"
  echo "products_plan<<PLAN_EOF"
  echo "$products_plan"
  echo "PLAN_EOF"
} >> "$GITHUB_OUTPUT"
