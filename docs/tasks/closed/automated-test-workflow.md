# Automated test workflow

`go test ./...` target; `go test -race` is not runnable on the arm64 Android dev
device ("race is not supported on android/arm64"), so wire it into CI whenever a
suitable host is available. Node unit tests run under `node --test
web/*.test.cjs tools/lib/*.test.mjs`. The protocol probes (`npm run tall`,
browser-free) run on the dev device itself against the deployed origin, so they
need no extra host; if a browser-level suite is ever wanted again it has to be a
host that can install Chromium, not this one.
