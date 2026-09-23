import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[3]
IMAGES = [
    {
        "name": name,
        "image": f"ghcr.io/example/{name}",
        "appDir": f"apps/{name}",
        "dockerTarget": name,
        "helmTagPath": f"{name}.tag",
    }
    for name in ("first", "second", "third")
]


def executable(path, contents):
    path.write_text(contents)
    path.chmod(0o755)


def run(script, env):
    result = subprocess.run(
        ["bash", str(script)], cwd=ROOT, env={**os.environ, **env},
        capture_output=True, text=True,
    )
    if result.returncode:
        raise AssertionError(f"{script} failed:\n{result.stdout}\n{result.stderr}")
    return result


def plan(event, mode="min", all_reused=False, include_probes=False):
    with tempfile.TemporaryDirectory(prefix="cache-plan-") as directory:
        directory = Path(directory)
        bin_dir = directory / "bin"
        bin_dir.mkdir()
        executable(bin_dir / "curl", r'''#!/usr/bin/env bash
for arg in "$@"; do url="$arg"; done
printf '%s\n' "$url" >> "$MOCK_CURL_LOG"
case "$url" in
  *'/contents/'*'/package.json?'*) printf '{"version":"1.0.0"}' ;;
  *'/commits/'*'/pulls') printf '[]' ;;
  *'/token?'*) printf '{"token":"test"}' ;;
  *'/manifests/'*)
    tag="${url##*/}"
    if [[ "$tag" == deps* || "$tag" == buildcache-* || ( "$tag" == 1.0.0* && ( "$MOCK_ALL_REUSED" == 1 || "$url" == *'/first/manifests/'* ) ) ]]; then
      printf '200'
    else
      printf '404'
    fi ;;
  *) echo "Unexpected curl URL: $url" >&2; exit 1 ;;
esac
''')
        output = directory / "output"
        output.touch()
        probes = directory / "probes"
        probes.touch()
        run(ROOT / ".github/actions/plan-images/plan-images.sh", {
            "PATH": f"{bin_dir}:{os.environ['PATH']}",
            "IMAGES_JSON": json.dumps(IMAGES),
            "PRODUCTS_JSON": "",
            "DO_DEPLOY": "false",
            "REGISTRY_CACHE_MODE": mode,
            "HELM_RELEASE": "test",
            "KUBE_NAMESPACE": "test",
            "HELM_CHART": "chart",
            "HELM_VALUES_FILE": "values.yaml",
            "GITHUB_REPOSITORY": "example/repo",
            "GITHUB_SHA": "abcdef0123456789",
            "GITHUB_EVENT_NAME": "pull_request" if event == "pr" else "push",
            "GITHUB_EVENT_ACTION": "synchronize" if event == "pr" else "",
            "PR_NUMBER": "42" if event == "pr" else "",
            "GH_TOKEN": "test",
            "GH_ACTOR": "test",
            "GITHUB_OUTPUT": str(output),
            "MOCK_ALL_REUSED": "1" if all_reused else "0",
            "MOCK_CURL_LOG": str(probes),
        })
        matrix = json.loads(next(line.removeprefix("build_matrix=") for line in output.read_text().splitlines()
                                 if line.startswith("build_matrix=")))
        return (matrix, probes.read_text()) if include_probes else matrix


def workflow_script(workflow, step_name):
    lines = (ROOT / ".github/workflows" / workflow).read_text().splitlines()
    step = lines.index(f"      - name: {step_name}")
    start = lines.index("        run: |", step)
    body = []
    for line in lines[start + 1:]:
        if line and not line.startswith("          "):
            break
        body.append(line[10:] if line else "")
    return "\n".join(body) + "\n"


def bake(workflow, matrix, registry_cache_mode="min"):
    with tempfile.TemporaryDirectory(prefix="cache-bake-") as directory:
        directory = Path(directory)
        bin_dir = directory / "bin"
        bin_dir.mkdir()
        executable(bin_dir / "docker", '''#!/usr/bin/env bash
previous=''
for arg in "$@"; do
  if [ "$previous" = '-f' ]; then cp "$arg" "$CAPTURE_BAKE_FILE"; exit 0; fi
  previous="$arg"
done
echo 'Missing bake file' >&2
exit 1
''')
        script = directory / "bake.sh"
        script.write_text(workflow_script(workflow, "Generate bake file and build all images"))
        capture = directory / "bake.json"
        run(script, {
            "PATH": f"{bin_dir}:{os.environ['PATH']}",
            "BUILD_MATRIX": json.dumps(matrix),
            "PLATFORMS": "linux/amd64",
            "ATTEST_MODE": "min",
            "REGISTRY_CACHE_MODE": registry_cache_mode,
            "CAPTURE_BAKE_FILE": str(capture),
            "GITHUB_STEP_SUMMARY": str(directory / "summary"),
        })
        return json.loads(capture.read_text())


def resolve(matrix, mode):
    with tempfile.TemporaryDirectory(prefix="cache-resolve-") as directory:
        directory = Path(directory)
        script = directory / "resolve.sh"
        script.write_text(workflow_script("build-images.yaml", "Resolve image build plan"))
        output = directory / "output"
        summary = directory / "summary"
        result = subprocess.run(["bash", str(script)], cwd=ROOT, capture_output=True, text=True,
                                env={**os.environ, "USE_PREPLANNED_PLAN": "true",
                                     "PREPLANNED_BUILD_MATRIX": json.dumps(matrix),
                                     "PLANNED_BUILD_MATRIX": "[]", "PLATFORMS": "linux/amd64",
                                     "ATTEST_MODE": "min", "REGISTRY_CACHE_MODE": mode,
                                     "GITHUB_OUTPUT": str(output), "GITHUB_STEP_SUMMARY": str(summary)})
        if result.returncode:
            return None, result.stderr
        text = output.read_text()
        return json.loads(text.split("build_matrix<<BUILD_MATRIX_EOF\n", 1)[1].split("\nBUILD_MATRIX_EOF", 1)[0]), ""


class CachePlanTest(unittest.TestCase):
    def test_main_and_pr_generated_bake_configs(self):
        for event in ("main", "pr"):
            for mode in ("none", "min", "max"):
                with self.subTest(event=event, mode=mode):
                    matrix, probes = plan(event, mode, include_probes=True)
                    self.assertEqual([item["name"] for item in matrix], ["second", "third"])
                    self.assertTrue(all(item["cacheMode"] == mode for item in matrix))
                    if mode == "none":
                        self.assertNotIn("buildcache-", probes)
                        self.assertNotIn("mm-buildcache", probes)
                    elif mode == "min":
                        self.assertIn("buildcache-min-", probes)
                        self.assertNotIn("mm-buildcache", probes)
                        self.assertNotIn("/buildcache-second-pr42", probes)
                    else:
                        self.assertIn("mm-buildcache", probes)
                        self.assertNotIn("buildcache-min-", probes)

                    resolved, error = resolve(matrix, mode)
                    self.assertEqual(error, "")
                    self.assertEqual(resolved, matrix)
                    for workflow in ("build-images.yaml", "build-and-deploy.yaml"):
                        with self.subTest(workflow=workflow):
                            definition = bake(workflow, resolved, registry_cache_mode=mode)
                            self.assertEqual(definition["group"]["default"]["targets"], ["second", "third"])
                            targets = definition["target"]
                            for name in ("second", "third"):
                                target = targets[name]
                                if mode == "none":
                                    self.assertNotIn("cache-from", target)
                                    self.assertNotIn("cache-to", target)
                                    continue
                                prefix = "buildcache-min" if mode == "min" else "buildcache"
                                tag = f"{prefix}-{name}" + ("-pr42" if event == "pr" else "")
                                self.assertIn(f"type=registry,ref=ghcr.io/example/{name}:{tag},mode={mode}",
                                              target["cache-to"])
                                self.assertTrue(all(ref.endswith(f",mode={mode}") for ref in target["cache-to"]))
                                self.assertIn(f"type=registry,ref=ghcr.io/example/{name}:{prefix}-{name}",
                                              target["cache-from"])
                                if event == "pr":
                                    self.assertIn(f"type=registry,ref=ghcr.io/example/{name}:{prefix}-{name}-pr42",
                                                  target["cache-from"])
                            if mode == "min":
                                self.assertTrue(all("mm-buildcache" not in ref for target in targets.values()
                                                    for ref in target["cache-from"] + target["cache-to"]))
                            if mode == "max":
                                shared = "ghcr.io/example/mm-buildcache:deps" + ("-pr42" if event == "pr" else "")
                                self.assertEqual(sum(shared in ref for target in targets.values()
                                                     for ref in target["cache-to"]), 1)
                                self.assertTrue(all("type=registry,ref=ghcr.io/example/mm-buildcache:deps" in
                                                    target["cache-from"] for target in targets.values()))
                            if workflow == "build-images.yaml":
                                self.assertEqual(targets["second"]["attest"], ["type=provenance,mode=min"])

    def test_all_reused_images_have_no_cache_exports(self):
        for mode in ("none", "min", "max"):
            self.assertEqual(plan("main", mode, all_reused=True), [])
            self.assertEqual(plan("pr", mode, all_reused=True), [])

    def test_preplanned_mode_validation_and_none_override(self):
        matrix = plan("main", "max")
        resolved, error = resolve(matrix, "min")
        self.assertIsNone(resolved)
        self.assertIn("does not match", error)
        resolved, error = resolve(matrix, "none")
        self.assertEqual(error, "")
        self.assertTrue(all(item["cacheFrom"] == item["cacheTo"] == "" for item in resolved))
        self.assertTrue(all(item["cacheMode"] == "none" for item in resolved))
        for item in matrix:
            item.pop("cacheMode")
        resolved, error = resolve(matrix, "min")
        self.assertEqual(error, "")
        self.assertEqual(resolved, matrix)

    def test_bake_respects_explicit_modes_and_falls_back_when_absent(self):
        matrix = plan("main", "min")
        for item in matrix:
            item.pop("cacheMode")
        matrix[0]["cacheTo"] = "type=registry,ref=ghcr.io/example/second:buildcache-second,mode=min"
        matrix[1]["cacheTo"] = "type=registry,ref=ghcr.io/example/third:buildcache-third"
        targets = bake("build-images.yaml", matrix, registry_cache_mode="max")["target"]
        self.assertEqual(targets["second"]["cache-to"],
                         ["type=registry,ref=ghcr.io/example/second:buildcache-second,mode=min"])
        self.assertEqual(targets["third"]["cache-to"],
                         ["type=registry,ref=ghcr.io/example/third:buildcache-third,mode=max"])

    def test_invalid_cache_mode_fails_before_probes(self):
        with self.assertRaisesRegex(AssertionError, "registry_cache_mode must be none, min, or max"):
            plan("main", "bogus")


if __name__ == "__main__":
    unittest.main()
