export GIT_COMMIT=$(git rev-parse HEAD)
export GIT_DATETIME=$(git log -1 --format=%cI)
docker compose up -d --build

while true; do
  if git pull gitea | grep -qv "Already up to date"; then
    git push origin
    export GIT_COMMIT=$(git rev-parse HEAD)
    export GIT_DATETIME=$(git log -1 --format=%cI)
    docker image rm -f hoto-sandbox:latest
    docker compose up -d --build
    date
  fi
  sleep 30
done

