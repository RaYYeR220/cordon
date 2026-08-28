#!/usr/bin/env bash
#
# Declare and deploy the Cordon contracts, in dependency order, and record the
# resulting addresses under deployments/<network>.json.
#
# Declaring a class that is already on chain is not an error: the script reads the
# class hash back from the build artifact either way. Deployment is not idempotent —
# re-running deploys fresh instances, so check the deployments file before running
# it twice against the same network.
#
# Usage:
#   OWNER=0x... ./scripts/deploy.sh sepolia
#   OWNER=0x... ./scripts/deploy.sh mainnet
#
# Required environment:
#   OWNER           address that will own the registries and the gate
#   SNCAST_ACCOUNT  sncast account name          (default: deployer)
#   ACCOUNTS_FILE   path to the sncast accounts file
#
# Optional:
#   DECLARE_L2_GAS  explicit L2 gas bound for declarations. sncast's own estimate is padded well
#                   above real usage — PolicyGate actually consumes about 823M L2 gas but the
#                   estimate reserves nearer 1.24G, which a correctly-sized balance can fail to
#                   cover. Set this to fund a deployment tightly. The network still charges only
#                   what is used; this is a ceiling, not a price.
#
set -euo pipefail

NETWORK="${1:-}"
case "$NETWORK" in
  mainnet)
    RPC="${STARKNET_RPC:-https://api.cartridge.gg/x/starknet/mainnet}"
    POOL="${STRK20_POOL:-0x040337b1af3c663e86e333bab5a4b28da8d4652a15a69beee2b677776ffe812a}"
    ;;
  sepolia)
    RPC="${STARKNET_RPC:-https://api.cartridge.gg/x/starknet/sepolia}"
    POOL="${STRK20_POOL:-0x0254a6b2997ef52e9f830ce1f543f6b29768295e8d17e2267d672c552cfe0d91}"
    ;;
  *) echo "usage: $0 {mainnet|sepolia}" >&2; exit 2 ;;
esac

: "${OWNER:?set OWNER to the address that should own the deployed contracts}"
ACCOUNT="${SNCAST_ACCOUNT:-deployer}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="$ROOT/deployments"
OUT="$OUT_DIR/$NETWORK.json"
mkdir -p "$OUT_DIR"

SNCAST=(sncast --json --wait --wait-timeout 300)
[ -n "${ACCOUNTS_FILE:-}" ] && SNCAST+=(--accounts-file "$ACCOUNTS_FILE")
SNCAST+=(--account "$ACCOUNT")

echo "network : $NETWORK"
echo "rpc     : $RPC"
echo "owner   : $OWNER"
echo "pool    : $POOL"
echo

# The gate binds the pool at construction: only that address may drive privacy_invoke, and it is the
# only address the gate will ever approve. Deploying against a wrong pool produces a gate that
# refuses every transaction, so confirm a contract is actually there first.
if ! curl -fsS -X POST "$RPC" -H 'content-type: application/json' \
     -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"starknet_getClassHashAt\",\"params\":[\"latest\",\"$POOL\"]}" \
   | grep -q '"result"'; then
  echo "no contract deployed at pool address $POOL on $NETWORK" >&2
  exit 1
fi

cd "$ROOT"
scarb build

# jq is not assumed; sncast --json emits one JSON object per line and python is already a
# prerequisite of the toolchain.
field() { python -c "
import json,sys
for line in sys.stdin:
    line = line.strip()
    if not line.startswith('{'): continue
    obj = json.loads(line)
    if '$1' in obj:
        print(obj['$1']); break
"; }

# Normalise a felt to a decimal string, so that leading zeros, quoting and array
# punctuation cannot make two equal addresses compare unequal.
felt() { python -c "
import re,sys
raw = sys.stdin.read()
m = re.search(r'0[xX][0-9a-fA-F]+', raw)
print(int(m.group(0), 16) if m else 'unreadable')
"; }

declare_class() {
  local name="$1" out hash bounds=()
  [ -n "${DECLARE_L2_GAS:-}" ] && bounds=(--l2-gas "$DECLARE_L2_GAS")
  out="$("${SNCAST[@]}" declare --url "$RPC" --contract-name "$name" "${bounds[@]}" 2>&1 || true)"
  hash="$(printf '%s' "$out" | field class_hash)"
  if [ -z "$hash" ]; then
    # A class that is already on chain is a success; anything else is not. Distinguish the two
    # rather than always falling back to the local artifact's hash: that reports a hash for a class
    # which never reached the chain, and the real failure only surfaces later as "class is not
    # declared" at deploy time, pointing at the wrong step.
    case "$out" in
      *"already declared"*|*"ClassAlreadyDeclared"*)
        hash="$(starkli class-hash "target/dev/cordon_$name.contract_class.json" 2>/dev/null || true)"
        echo "declare $name: already on chain" >&2
        ;;
      *)
        echo "declaring $name failed:" >&2
        printf '%s' "$out" >&2; echo >&2
        exit 1
        ;;
    esac
  fi
  [ -n "$hash" ] || { echo "could not determine a class hash for $name" >&2; printf '%s\n' "$out" >&2; exit 1; }
  echo "declare $name -> $hash" >&2
  echo "$hash"
}

deploy() {
  local hash="$1"; shift
  "${SNCAST[@]}" deploy --url "$RPC" --class-hash "$hash" --constructor-calldata "$@" | field contract_address
}

ISSUER_CLASS="$(declare_class IssuerRegistry)"
REVOCATION_CLASS="$(declare_class RevocationRegistry)"
POLICY_CLASS="$(declare_class PolicyRegistry)"
GATE_CLASS="$(declare_class PolicyGate)"

echo
echo "deploying..."

ISSUER_REGISTRY="$(deploy "$ISSUER_CLASS" "$OWNER")"
echo "IssuerRegistry      $ISSUER_REGISTRY"

REVOCATION_REGISTRY="$(deploy "$REVOCATION_CLASS" "$OWNER" "$ISSUER_REGISTRY")"
echo "RevocationRegistry  $REVOCATION_REGISTRY"

POLICY_REGISTRY="$(deploy "$POLICY_CLASS" "$OWNER")"
echo "PolicyRegistry      $POLICY_REGISTRY"

POLICY_GATE="$(deploy "$GATE_CLASS" "$OWNER" "$POOL" "$ISSUER_REGISTRY" "$REVOCATION_REGISTRY" "$POLICY_REGISTRY")"
echo "PolicyGate          $POLICY_GATE"

# The pool and the registry pointers are immutable after construction, so a wrong address here is
# only fixable by redeploying. Read them back and fail loudly rather than recording a broken gate.
echo
echo "verifying the deployed gate..."
for pair in "privacy_pool:$POOL" "issuer_registry:$ISSUER_REGISTRY" \
            "revocation_registry:$REVOCATION_REGISTRY" "policy_registry:$POLICY_REGISTRY"; do
  getter="${pair%%:*}"; expected="${pair#*:}"
  actual="$("${SNCAST[@]}" call --url "$RPC" --contract-address "$POLICY_GATE" \
            --function "$getter" | field response_raw | felt)"
  if [ "$actual" = "$(printf '%s' "$expected" | felt)" ]; then
    echo "  ok   $getter"
  else
    echo "  FAIL $getter: gate reports $actual, expected $expected" >&2
    exit 1
  fi
done

cat > "$OUT" <<JSON
{
  "network": "$NETWORK",
  "rpc": "$RPC",
  "owner": "$OWNER",
  "strk20_pool": "$POOL",
  "classes": {
    "IssuerRegistry": "$ISSUER_CLASS",
    "RevocationRegistry": "$REVOCATION_CLASS",
    "PolicyRegistry": "$POLICY_CLASS",
    "PolicyGate": "$GATE_CLASS"
  },
  "contracts": {
    "IssuerRegistry": "$ISSUER_REGISTRY",
    "RevocationRegistry": "$REVOCATION_REGISTRY",
    "PolicyRegistry": "$POLICY_REGISTRY",
    "PolicyGate": "$POLICY_GATE"
  }
}
JSON

echo
echo "wrote $OUT"
