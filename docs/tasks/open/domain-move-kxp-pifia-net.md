---
phase: 5
---

# Domain move to kxp.pifia.net (with kxp.tao.cl as a redirect)

`kxp.pifia.net` becomes the canonical address of the deployed server, and the
old name `kxp.tao.cl` becomes a 301 to it. The repo side landed in the
`Docs: move the live domain to kxp.pifia.net` commit — README's play link, the
deploy doc's opening line, and `deploy.sh`'s default `HEALTH_URL`. This file
covers the host side, which is not in this repo and was applied by hand.

## What this was, and why it is recorded here rather than in the repo

Half the work has no diff: the nginx vhosts, the TLS certificate and the
redirect live on the VPS ([deployment.md](../../development/deployment.md) says
why they stay there). That is exactly why a record belongs somewhere — a
redirect that was set up and forgotten is indistinguishable from one that was
never set up, and the next person to see `kxp.tao.cl` answer 301 would otherwise
have to guess at its provenance.

## Applied on the host

The pattern followed is the sibling `asteroids.pifia.net` vhost on the same
host: a single site file with `location /` and `location /events` both
proxying to the loopback, and `proxy_buffering off` only on `/events`, which is
what SSE needs.

1. `/etc/nginx/sites-available/kxp.pifia.net` → new vhost, proxying to
   `127.0.0.1:18080` (the same service `kxp.tao.cl` proxied to). Enabled by
   symlink into `sites-enabled/`.
2. `certbot --nginx -d kxp.pifia.net --redirect` → Let's Encrypt certificate
   issued 2026-10-20, auto-renewing, and the 80→443 redirect for the new name.
3. `/etc/nginx/sites-available/kxp.tao.cl` → rewritten from a proxy to
   `return 301 https://kxp.pifia.net$request_uri` on all four listen blocks, so
   a client that typed the old name lands on the new origin in one hop with its
   path preserved. The pre-change file is kept beside it as
   `kxp.tao.cl.bak` — this file's rollback.
4. `nginx -t`, then reload. No service restart was needed; the Go service is
   untouched by any of this.

## Why the redirect keeps the old certificate

The obvious cheaper shape — delete the `kxp.tao.cl` cert and let certbot's
default catch-all serve the redirect — breaks the chain. The redirect is
`https://kxp.pifia.net`, and TLS terminates before a 301 is read, so a plain
`http://kxp.tao.cl` client would get one hop to `https://kxp.tao.cl`, a
certificate error, and never reach the redirect. Keeping the cert is what makes
"old name still works" true rather than nominally true.

## Verified

Against the live host, from the phone, 2026-10-20:

- `https://kxp.pifia.net/health` → 200, correct build JSON.
- `http://kxp.pifia.net/health` → 301 to the https URL.
- `https://kxp.tao.cl/health` → 301 → `https://kxp.pifia.net/health`;
  `https://kxp.tao.cl/diag.html?x=1` → 301 → `.../diag.html?x=1` (path and query
  preserved); `http://kxp.tao.cl/` → 301 → `https://kxp.pifia.net/`; following
  the chain returns the build JSON.
- `sh deploy.sh` → deployed `0eeb815…`, health check against the new default
  URL passed. This is the real test of the URL move: the check has to reach the
  new name, and it fails loudly if it does not.
- `npm run t1` → **PASS**, 5/5, and it confirms production runs local `HEAD`
  (`0eeb815`, `ldflags`).
- `QUICK=1 npm run tall` → **4 passed, 0 failed, 0 inconclusive** (t1–t4,
  which is the whole set `QUICK` runs).
- `gofmt -l .` clean, `go vet ./...` ok, `npm run links` 0 broken.

**Not run / not covered on this host:** `go test ./...`, `npm run unit` and the
browser suite. The change is markdown and one default URL in a shell script, so
none of them exercises it — the gate that does is `t1`, and it passed. `-race`
and Chromium remain CI's. No rendering claim is made; the new vhost serves the
identical embedded UI as the old one, so nothing renderable changed. Real radio
behaviour is unmeasurable here as always.

## Open item

None of this is deployable from the repo, so there is nothing further to land.
If the old name should eventually stop working entirely, that is a decision to
take later — it is a certificate renewal away from being irreversible, which is
why nothing here retires the `kxp.tao.cl` cert or its renewal job.
