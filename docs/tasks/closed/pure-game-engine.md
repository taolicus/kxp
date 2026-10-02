# Pure game engine

`round.go`'s `match` no longer touches `Hub`, `Client`, or SSE; sides are
neutral `matchParty` and the hub wires `finish`/`requeue` callbacks back to real
clients.
