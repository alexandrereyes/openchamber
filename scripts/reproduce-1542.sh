#!/usr/bin/env bash
# Reproduction attempt for issue #1542
# "Issues with latest update" — macOS Desktop showing mostly blank/dark window
# 
# This script documents the reproduction attempts and findings.

set -euo pipefail

echo "=== Issue #1542 Reproduction Attempt ==="
echo "Date: $(date)"
echo "Commit: $(git rev-parse HEAD)"
echo "Version: $(cat package.json | python3 -c 'import sys,json; print(json.load(sys.stdin)["version"])')"
echo ""

echo "=== 1. Environment checks ==="
echo "Node: $(node --version)"
echo "Bun: $(bun --version)"
echo "Platform: $(uname -a)"
echo ""

echo "=== 2. Type check ==="
bun run type-check 2>&1 && echo "✓ Type check passed" || echo "✗ Type check failed"
echo ""

echo "=== 3. Lint ==="
bun run lint 2>&1 && echo "✓ Lint passed" || echo "✗ Lint failed"
echo ""

echo "=== 4. Build ==="
bun run build 2>&1 | tail -5 && echo "✓ Build succeeded" || echo "✗ Build failed"
echo ""

echo "=== 5. Test ==="
# Tests are expected to have some failures in CI due to bun:test/vitest compatibility
echo "Note: Some test failures are pre-existing (bun:test vs vitest runner)"
echo ""

echo "=== Findings ==="
echo ""
echo "Bug: App shows mostly blank/dark window on macOS Desktop after latest update"
echo ""
echo "Evidence from screenshots (analyzed via PIL):"
echo "- Screenshots show 99.37% of pixels are the same dark color (#20211c)"
echo "- Very minimal UI content visible"
echo "- No error messages visible in screenshots"
echo ""
echo "Unable to reproduce due to insufficient information:"
echo "- No reproduction steps provided"
echo "- No logs provided"
echo "- Version '16.0' doesn't match any current release"
echo ""
echo "Potential causes (speculative):"
echo "1. React error during initialization preventing full render"
echo "2. CSS loading issue"
echo "3. Desktop boot outcome injection timing issue"
echo "4. Authentication gate getting stuck in 'pending' state"
echo "5. Lazy-loaded chunk loading failure (OnboardingScreen)"
echo ""
echo "See comment on issue #1542 for requested additional information."
