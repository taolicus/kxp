package main

import "math/rand/v2"

type Character struct {
	ID   string
	Name string
}

var characters = []Character{
	{ID: "scorpion", Name: "Scorpion"},
	{ID: "subzero", Name: "Sub-Zero"},
	{ID: "raiden", Name: "Raiden"},
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
