#!/usr/bin/env bash
#
# Declare and deploy the Cordon contracts, in dependency order, and record the
# resulting addresses under deployments/<network>.json.
#
# The script is idempotent: declaring a class that is already on chain is not an
# error, and re-running after a partial failure re-uses the classes it already
# declared. Deployment itself is not idempotent — re-running deploys fresh
# instances, so check the deployments file before you run it twice.
#
# Usage:
#   OWNER=0x... ./scripts/deploy.sh mainnet
#   OWNER=0x... ./scripts/deploy.sh sepolia
#
# Required environment:
#   OWNER                       address that will own the registries and the gate
#   STARKNET_ACCOUNT            path to the starkli account file
#   STARKNET_KEYSTORE           path to the starkli keystore file
#   STARKNET_KEYSTORE_PASSWORD  keystore password
#
set -euo pipefail

NETWORK="${1:-}"
case "$NETWORK" in
  mainnet) RPC="${STARKNET_RPC:-https://api.cartridge.gg/x/starknet/mainnet}" ;;
  sepolia) RPC="${STARKNET_RPC:-https://api.cartridge.gg/x/starknet/sepolia}" ;;
  *) echo "usage: $0 {mainnet|sepolia}" >&2; exit 2 ;;
esac

: "${OWNER:?set OWNER to the address that should own the deployed contracts}"
: "${STARKNET_ACCOUNT:?set STARKNET_ACCOUNT to your starkli account file}"
: "${STARKNET_KEYSTORE:?set STARKNET_KEYSTORE to your starkli keystore file}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ARTIFACTS="$ROOT/target/dev"
OUT_DIR="$ROOT/deployments"
OUT="$OUT_DIR/$NETWORK.json"
mkdir -p "$OUT_DIR"

echo "network : $NETWORK"
echo "rpc     : $RPC"
echo "owner   : $OWNER"
echo

scarb build

# Declare a class and echo its hash. starkli exits non-zero on a genuine failure,
# but treats an already-declared class as success and still prints the hash, so
# the hash is recovered from the artifact either way.
declare_class() {
  local name="$1"
  local artifact="$ARTIFACTS/cordon_$name.contract_class.json"
  local hash
  hash="$(starkli class-hash "$artifact")"

  if starkli class-by-hash "$hash" --rpc "$RPC" >/dev/null 2>&1; then
    echo "declare $name: already on chain" >&2
  else
    echo "declare $name: $hash" >&2
    starkli declare "$artifact" --rpc "$RPC" --watch >/dev/null
  fi
  echo "$hash"
}

deploy() {
  local hash="$1"; shift
  starkli deploy "$hash" "$@" --rpc "$RPC" --watch --not-unique 2>/dev/null | tail -n 1
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

POLICY_GATE="$(deploy "$GATE_CLASS" "$OWNER" "$ISSUER_REGISTRY" "$REVOCATION_REGISTRY" "$POLICY_REGISTRY")"
echo "PolicyGate          $POLICY_GATE"

cat > "$OUT" <<JSON
{
  "network": "$NETWORK",
  "rpc": "$RPC",
  "owner": "$OWNER",
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
