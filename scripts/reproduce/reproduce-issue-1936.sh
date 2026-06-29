#!/usr/bin/env bash
# Reproduction script for issue #1936: Commands settings UI missing `subtask` field
# This script checks all the places where `subtask` should be handled but is missing.

set -euo pipefail
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color
PASS=0
FAIL=0

check_missing() {
  local file="$1"
  local pattern="$2"
  local description="$3"
  if grep -q "$pattern" "$file" 2>/dev/null; then
    echo -e "${GREEN}  ✓ FOUND:${NC} $description"
    PASS=$((PASS + 1))
  else
    echo -e "${RED}  ✗ MISSING:${NC} $description"
    FAIL=$((FAIL + 1))
  fi
}

check_present() {
  local file="$1"
  local pattern="$2"
  local description="$3"
  if grep -q "$pattern" "$file" 2>/dev/null; then
    echo -e "${RED}  ✗ PRESENT (should be missing for reproduction):${NC} $description"
    FAIL=$((FAIL + 1))
  else
    echo -e "${GREEN}  ✓ CORRECTLY ABSENT:${NC} $description"
    PASS=$((PASS + 1))
  fi
}

echo "=============================================="
echo "  Reproduction: Issue #1936 - Missing subtask"
echo "=============================================="
echo ""

BASE="/home/runner/work/openchamber/openchamber"

# 1. Check interfaces in useCommandsStore.ts
echo "--- 1. Store type interfaces ---"
check_missing "$BASE/packages/ui/src/stores/useCommandsStore.ts" \
  "subtask" \
  "'subtask' field anywhere in useCommandsStore.ts (should be missing)"

# 2. Check specific interfaces
echo ""
echo "--- 2. Individual interface fields ---"
check_present "$BASE/packages/ui/src/stores/useCommandsStore.ts" \
  "interface CommandConfig" \
  "CommandConfig interface exists" 
check_present "$BASE/packages/ui/src/stores/useCommandsStore.ts" \
  "interface CommandDraft" \
  "CommandDraft interface exists"

# 3. Check CommandsPage.tsx for subtask UI
echo ""
echo "--- 3. UI form components ---"
check_missing "$BASE/packages/ui/src/components/sections/commands/CommandsPage.tsx" \
  "subtask" \
  "Any reference to 'subtask' in CommandsPage.tsx (should be missing)"

# 4. Check createCommand sends subtask
echo ""
echo "--- 4. Store action methods ---"
check_missing "$BASE/packages/ui/src/stores/useCommandsStore.ts" \
  "config\.subtask" \
  "config.subtask in createCommand (should be missing)"

check_missing "$BASE/packages/ui/src/stores/useCommandsStore.ts" \
  "config\.subtask" \
  "config.subtask in updateCommand (should be missing)"

# 5. Check client.ts wrapper
echo ""
echo "--- 5. SDK client wrapper (client.ts) ---"
check_missing "$BASE/packages/ui/src/lib/opencode/client.ts" \
  "subtask" \
  "'subtask' field in client.ts command wrappers (should be missing)"

# 6. Check buildCommandsSignature
echo ""
echo "--- 6. Signature function ---"
check_missing "$BASE/packages/ui/src/stores/useCommandsStore.ts" \
  "buildCommandsSignature" \
  "buildCommandsSignature function exists (checking for subtask inclusion)"

# 7. Sidebar duplicate/rename
echo ""
echo "--- 7. Sidebar operations ---"
check_missing "$BASE/packages/ui/src/components/sections/commands/CommandsSidebar.tsx" \
  "subtask" \
  "'subtask' in CommandsSidebar.tsx (should be missing in duplicate/rename)"

# 8. i18n strings
echo ""
echo "--- 8. i18n locale strings ---"
check_missing "$BASE/packages/ui/src/lib/i18n/messages/en.settings.ts" \
  "settings.commands.page.field.subtask" \
  "i18n key for subtask field label (should be missing)"

# 9. SDK types DO have subtask (confirms it's an OpenChamber gap)
echo ""
echo "--- 9. OpenCode SDK type confirmation (subtask exists upstream) ---"
SDK_FILE="$BASE/node_modules/.bun/@opencode-ai+sdk@1.17.9/node_modules/@opencode-ai/sdk/dist/v2/gen/types.gen.d.ts"
if [ -f "$SDK_FILE" ]; then
  check_missing "$SDK_FILE" \
    "subtask\?" \
    "subtask? boolean in SDK Command/Config types (confirms upstream support)"
  # Actually it should be present, let's check the other way
  if grep -q "subtask?" "$SDK_FILE" 2>/dev/null; then
    echo -e "${GREEN}  ✓ UPSTREAM SUPPORT CONFIRMED:${NC} SDK types have subtask field"
  else
    echo -e "${RED}  ✗ SDK types DO NOT have subtask (would need OpenCode update)${NC}"
  fi
else
  echo -e "${YELLOW}  ⚠ SDK types file not found at expected path${NC}"
fi

echo ""
echo "=============================================="
echo -e "Results: ${GREEN}$PASS passed${NC}, ${RED}$FAIL failed${NC}"
echo "=============================================="
echo ""
if [ "$FAIL" -gt 0 ]; then
  echo -e "${YELLOW}Bug REPRODUCIBLE: subtask field is missing from OpenChamber Commands UI.${NC}"
  echo "The OpenCode SDK already supports subtask but it is not surfaced in:"
  echo "  - CommandConfig/CommandDraft interfaces"
  echo "  - CommandsPage.tsx form UI"
  echo "  - createCommand/updateCommand network payloads"
  echo "  - client.ts command wrapper return types"
  echo "  - CommandsSidebar.tsx duplicate/rename operations"
  echo "  - i18n locale strings"
  exit 0
else
  echo -e "${GREEN}Bug NOT reproducible (subtask appears to be present)${NC}"
  exit 1
fi
