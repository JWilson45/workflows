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


def plan(event, all_reused=False):
    with tempfile.TemporaryDirectory(prefix="cache-plan-") as directory:
        directory = Path(directory)
        bin_dir = directory / "bin"
        bin_dir.mkdir()
        executable(bin_dir / "curl", r'''#!/usr/bin/env bash
for arg in "$@"; do url="$arg"; done
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
        run(ROOT / ".github/actions/plan-images/plan-images.sh", {
            "PATH": f"{bin_dir}:{os.environ['PATH']}",
            "IMAGES_JSON": json.dumps(IMAGES),
            "PRODUCTS_JSON": "",
            "DO_DEPLOY": "false",
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
        })
        return json.loads(next(line.removeprefix("build_matrix=") for line in output.read_text().splitlines()
                               if line.startswith("build_matrix=")))


def bake_script(workflow):
    lines = (ROOT / ".github/workflows" / workflow).read_text().splitlines()
    step = lines.index("      - name: Generate bake file and build all images")
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
        script.write_text(bake_script(workflow))
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


class CachePlanTest(unittest.TestCase):
    def test_main_and_pr_generated_bake_configs(self):
        for event in ("main", "pr"):
            with self.subTest(event=event):
                matrix = plan(event)
                self.assertEqual([item["name"] for item in matrix], ["second", "third"])
                shared = "ghcr.io/example/mm-buildcache:deps" + ("-pr42" if event == "pr" else "")
                for workflow in ("build-images.yaml", "build-and-deploy.yaml"):
                    with self.subTest(workflow=workflow):
                        definition = bake(workflow, matrix)
                        self.assertEqual(definition["group"]["default"]["targets"], ["second", "third"])
                        targets = definition["target"]
                        self.assertEqual(sum(shared in ref for target in targets.values()
                                             for ref in target["cache-to"]), 1)
                        for name in ("second", "third"):
                            target = targets[name]
                            self.assertIn("type=registry,ref=ghcr.io/example/mm-buildcache:deps",
                                          target["cache-from"])
                            image_tag = f"buildcache-{name}" + ("-pr42" if event == "pr" else "")
                            self.assertIn(f"type=registry,ref=ghcr.io/example/{name}:{image_tag},mode=max",
                                          target["cache-to"])
                            self.assertTrue(all(ref.endswith(",mode=max") for ref in target["cache-to"]))
                        if workflow == "build-images.yaml":
                            self.assertEqual(targets["second"]["attest"], ["type=provenance,mode=min"])

    def test_all_reused_images_have_no_cache_exports(self):
        self.assertEqual(plan("main", all_reused=True), [])
        self.assertEqual(plan("pr", all_reused=True), [])

    def test_bake_respects_explicit_modes_and_falls_back_when_absent(self):
        matrix = plan("main")
        matrix[0]["cacheTo"] = "type=registry,ref=ghcr.io/example/second:buildcache-second,mode=min"
        matrix[1]["cacheTo"] = "type=registry,ref=ghcr.io/example/third:buildcache-third"
        targets = bake("build-images.yaml", matrix, registry_cache_mode="max")["target"]
        self.assertEqual(targets["second"]["cache-to"],
                         ["type=registry,ref=ghcr.io/example/second:buildcache-second,mode=min"])
        self.assertEqual(targets["third"]["cache-to"],
                         ["type=registry,ref=ghcr.io/example/third:buildcache-third,mode=max"])


if __name__ == "__main__":
    unittest.main()
