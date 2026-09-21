#!/usr/bin/env bash
# Installs the contract dependencies at the versions this project was built against.
# They are not kept in the repository, so a fresh clone runs this once.
. "$(dirname "$0")/lib.sh"
need forge

cd "$ROOT/contracts"
install_dep() {
  local repo=$1 tag=$2 dir=$3
  if [ -d "lib/$dir/src" ] || [ -d "lib/$dir/contracts" ]; then
    say "$dir already installed"
    return 0
  fi
  say "installing $repo@$tag"
  forge install "$repo@$tag" --no-git >/dev/null
}

install_dep foundry-rs/forge-std v1.16.2 forge-std
install_dep OpenZeppelin/openzeppelin-contracts v5.5.0 openzeppelin-contracts
install_dep aave-dao/aave-v3-origin v3.4.0 aave-v3-origin

# Foundry reads a .env from its own project root. Point it at the one .env this
# project keeps, so `forge test` works when run by hand from contracts/ too.
if [ -f "$ROOT/.env" ] && [ ! -e "$ROOT/contracts/.env" ]; then
  ln -s ../.env "$ROOT/contracts/.env"
  say "linked contracts/.env to the project .env"
fi

say "building contracts"
forge build >/dev/null
say "contract dependencies ready"
