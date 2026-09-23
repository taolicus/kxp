package main

import "math/rand/v2"

type Character struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Emoji string `json:"emoji"`
}

var characters = []Character{
	{ID: "dragon-chino", Name: "Dragon Chino", Emoji: "🐉"},
	{ID: "sombrero-loco", Name: "Sombrero Loco", Emoji: "🎩"},
	{ID: "lentes-de-sol", Name: "Lentes de Sol", Emoji: "🕶️"},
	{ID: "lagartijo", Name: "Lagartijo", Emoji: "🦎"},
	{ID: "hielito", Name: "Hielito", Emoji: "🧊"},
	{ID: "cambiaformas", Name: "Cambiaformas", Emoji: "🦎"},
	{ID: "fabulosa", Name: "Fabulosa", Emoji: "🪭"},
	{ID: "robok", Name: "Robok", Emoji: "🦾"},
	{ID: "rafaela", Name: "Rafaela", Emoji: "⚔️"},
	{ID: "bicho-raro", Name: "Bicho Raro", Emoji: "🦗"},
	{ID: "alakran", Name: "Alakran", Emoji: "🦂"},
	{ID: "rayito", Name: "Rayito", Emoji: "⚡"},
}

func characterByID(id string) (Character, bool) {
	for _, c := range characters {
		if c.ID == id {
			return c, true
		}
	}
	return Character{}, false
}

func defaultCharacterID() string {
	return characters[0].ID
}

func validCharacter(id string) bool {
	_, ok := characterByID(id)
	return ok
}

func randomCharacterID() string {
	return characters[rand.IntN(len(characters))].ID
}
