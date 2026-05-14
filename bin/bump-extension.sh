#!/usr/bin/env bash
# Bumps the Chrome extension's manifest version so Chrome detects the change
# next time you click "Reload" on chrome://extensions.
#
# Versioning scheme: keeps your major.minor (1.0) and appends a build number
# derived from the current epoch second, e.g. 1.0.1761412345.
#
# Run after any edit to content.js / popup.js / api-config.js. Pair with a
# manual click on chrome://extensions → reload → hard-refresh the LinkedIn tab.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MANIFEST="$ROOT/app/job-copilot-extension/manifest.json"

if [[ ! -f "$MANIFEST" ]]; then
  echo "[bump] manifest not found at $MANIFEST" >&2
  exit 1
fi

# Pull base "X.Y" from the existing version, fall back to 1.0
base="$(python3 -c "import json,sys; v=json.load(open('$MANIFEST'))['version']; parts=v.split('.'); print('.'.join(parts[:2]) if len(parts)>=2 else '1.0')")"
build="$(date +%s)"
new="${base}.${build}"

python3 - "$MANIFEST" "$new" <<'PY'
import json, sys
path, new = sys.argv[1], sys.argv[2]
with open(path) as f:
    m = json.load(f)
old = m.get("version")
m["version"] = new
with open(path, "w") as f:
    json.dump(m, f, indent=2)
    f.write("\n")
print(f"[bump] {old} -> {new}")
PY

cat <<EOF

Next: open chrome://extensions → Job Copilot → click reload (circular arrow).
Then hard-refresh the LinkedIn job tab (Cmd+Shift+R).
EOF
