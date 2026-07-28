# kxp

A simple proof-of-concept command line Rock-Paper-Scissors game written in Go.

## Requirements

- Go (version 1.18 or higher)

## How to Run

Clone the repository and run the game directly using the Go toolchain:

go run main.go

## How to Play

1. Follow the on-screen menu prompts.
2. Enter the corresponding number (1, 2, or 3) to select your move:
   - [1] Rock
   - [2] Paper
   - [3] Scissors
3. View the round evaluation and outcome in the terminal.

## Roadmap

- [x] Basic game logic & rule evaluation
- [x] Numbered terminal UI menu input
- [ ] Refactor interface using Bubble Tea
- [ ] Add TCP/WebSocket network layer for 2-player support
- [ ] Implement matchmaking server for online play
