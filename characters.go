package main

import "math/rand/v2"

type Character struct {
	ID   string
	Name string
}

var characters = []Character{
	{ID: "scorpion", Name: "Alakran"},
	{ID: "subzero", Name: "Hielito"},
	{ID: "raiden", Name: "Rayito"},
	{ID: "liukang", Name: "Fueguito"},
	{ID: "smoke", Name: "Humito"},
	{ID: "reptile", Name: "Lagartijo"},
	{ID: "jax", Name: "Bracitos"},
	{ID: "kitana", Name: "Abaniquita"},
	{ID: "baraka", Name: "Navajita"},
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
