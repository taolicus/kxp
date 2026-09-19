package main

// newPartiedMatch builds an engine match wired to concrete clients, for tests
// that exercise resolve()/abort()/etc. without running a match or a hub.
func newPartiedMatch(a, b *Client) *match {
	m := newMatch("tm")
	m.sides[0] = matchParty{
		name:      "Opponent",
		character: a.character,
		emit:      a.sendEv,
		moves:     a.moves,
		left:      a.alive.Done(),
	}
	m.sides[1] = matchParty{
		name:      "Opponent",
		character: b.character,
		emit:      b.sendEv,
		moves:     b.moves,
		left:      b.alive.Done(),
	}
	return m
}
