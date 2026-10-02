# Resource limits

Caps on live clients (`maxClients`, hit in `getOrCreate`/`GET /events`), queue
length (`maxQueue`, hit on `/queue`), and active matches (`maxMatches`, hit on
`/cpu`); over-cap requests get `503`. Existing clients are never rejected, so
the caps only bite new growth.
