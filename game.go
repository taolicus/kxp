package main

import (
	"math/rand/v2"
)

type Move string
type Result string

const (
	MoveRock     Move = "rock"
	MovePaper    Move = "paper"
	MoveScissors Move = "scissors"

	ResultWin  Result = "win"
	ResultLoss Result = "loss"
	ResultDraw Result = "draw"
)

var winsAgainst = map[Move]Move{
	MoveRock:     MoveScissors,
	MovePaper:    MoveRock,
	MoveScissors: MovePaper,
}

func ValidMove(m Move) bool {
	switch m {
	case MoveRock, MovePaper, MoveScissors:
		return true
	}
	return false
}

func EvaluateRound(p1, p2 Move) Result {
	if p1 == p2 {
		return ResultDraw
	}
	if winsAgainst[p1] == p2 {
		return ResultWin
	}
	return ResultLoss
}

func randomMove() Move {
	moves := []Move{MoveRock, MovePaper, MoveScissors}
	return moves[rand.IntN(len(moves))]
}
