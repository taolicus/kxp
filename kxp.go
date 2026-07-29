package main

import (
	"context"
	"fmt"
	"math/rand/v2"
	"os"
	"strings"
	"time"

	"golang.org/x/term"
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

var menuOptions = []Move{MoveRock, MovePaper, MoveScissors}

var winsAgainst = map[Move]Move{
	MoveRock:     MoveScissors,
	MovePaper:    MoveRock,
	MoveScissors: MovePaper,
}

type InputResult struct {
	Move           Move
	InputTime      time.Time
	TimeDifference time.Duration
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

func runCountdown(ctx context.Context, targetTimeChan chan<- time.Time) {
	countdown := []string{"ROCK...", "PAPER...", "SCISSORS..."}
	fmt.Print("\r\n=== GET READY ===\r\n")
	fmt.Print("Press key (1: Rock, 2: Paper, 3: Scissors) right on SHOOT!\r\n\r\n")

	for _, word := range countdown {
		select {
		case <-ctx.Done():
			return
		case <-time.After(1 * time.Second):
			fmt.Printf("%s\r\n", word)
		}
	}

	targetTime := time.Now()
	select {
	case targetTimeChan <- targetTime:
		fmt.Print("\r\n*** SHOOT! ***\r\n")
	case <-ctx.Done():
	}
}

// Single keypress listener using non-canonical raw terminal mode
func getPlayerInput(ctx context.Context, inputChan chan<- InputResult) {
	readChan := make(chan byte, 1)

	// Non-blocking terminal read loop
	go func() {
		var buf [1]byte
		for {
			n, err := os.Stdin.Read(buf[:])
			if err != nil || n == 0 {
				return
			}
			select {
			case readChan <- buf[0]:
			case <-ctx.Done():
				return
			}
		}
	}()

	for {
		select {
		case <-ctx.Done():
			return
		case char := <-readChan:
			inputTime := time.Now()

			var chosenMove Move
			switch char {
			case '1':
				chosenMove = MoveRock
			case '2':
				chosenMove = MovePaper
			case '3':
				chosenMove = MoveScissors
			default:
				continue
			}

			select {
			case inputChan <- InputResult{Move: chosenMove, InputTime: inputTime}:
			case <-ctx.Done():
			}
			return
		}
	}
}

func getCPUInput(ctx context.Context, targetTime time.Time, cpuChan chan<- InputResult) {
	reactionDelay := time.Duration(50+rand.IntN(300)) * time.Millisecond

	select {
	case <-ctx.Done():
		return
	case <-time.After(reactionDelay):
	}

	res := InputResult{
		Move:           menuOptions[rand.IntN(len(menuOptions))],
		InputTime:      targetTime.Add(reactionDelay),
		TimeDifference: reactionDelay,
	}

	select {
	case cpuChan <- res:
	case <-ctx.Done():
	}
}

func main() {
	// Put terminal in raw mode to read single keypresses without Enter
	oldState, err := term.MakeRaw(int(os.Stdin.Fd()))
	if err != nil {
		fmt.Printf("Failed to enable raw terminal mode: %v\n", err)
		return
	}
	defer term.Restore(int(os.Stdin.Fd()), oldState)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	targetTimeChan := make(chan time.Time, 1)
	playerInputChan := make(chan InputResult, 1)
	cpuChan := make(chan InputResult, 1)

	go getPlayerInput(ctx, playerInputChan)
	go runCountdown(ctx, targetTimeChan)

	var targetTime time.Time
	select {
	case targetTime = <-targetTimeChan:
	case <-time.After(5 * time.Second):
		fmt.Print("\r\nGame timed out during countdown.\r\n")
		return
	}

	go getCPUInput(ctx, targetTime, cpuChan)

	var playerRes, cpuRes InputResult
	timeout := time.After(2 * time.Second)

	select {
	case playerRes = <-playerInputChan:
		playerRes.TimeDifference = playerRes.InputTime.Sub(targetTime)
	case <-timeout:
		fmt.Print("\r\n\r\nToo slow! You failed to enter a move in time.\r\n")
		return
	}

	select {
	case cpuRes = <-cpuChan:
	case <-time.After(1 * time.Second):
		fmt.Print("\r\nError waiting for CPU turn.\r\n")
		return
	}

	fmt.Print("\r\n--- Outcome ---\r\n")
	fmt.Printf("You chose %s (Timing: %v relative to SHOOT!)\r\n", strings.ToUpper(string(playerRes.Move)), playerRes.TimeDifference)
	fmt.Printf("CPU chose %s (Timing: +%v relative to SHOOT!)\r\n", strings.ToUpper(string(cpuRes.Move)), cpuRes.TimeDifference)

	if playerRes.TimeDifference < -200*time.Millisecond {
		fmt.Print("\r\nDisqualified! You entered your move too early before SHOOT!\r\n")
		return
	}

	result := EvaluateRound(playerRes.Move, cpuRes.Move)
	switch result {
	case ResultDraw:
		fmt.Print("It's a draw!\r\n")
	case ResultWin:
		fmt.Print("You win!\r\n")
	case ResultLoss:
		fmt.Print("Computer wins!\r\n")
	}
}
