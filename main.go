package main

import (
	"embed"
	"flag"
	"fmt"
	"io/fs"
	"log"
	"net"
	"net/http"
)

//go:embed web
var webFS embed.FS

func main() {
	addr := flag.String("addr", "", "listen address (default: auto-pick from 8000–8999)")
	flag.Parse()

	sub, err := fs.Sub(webFS, "web")
	if err != nil {
		log.Fatal(err)
	}

	hub := NewHub()

	mux := http.NewServeMux()
	mux.Handle("/", http.FileServer(http.FS(sub)))
	mux.HandleFunc("GET /events", hub.handleEvents)
	mux.HandleFunc("POST /queue", hub.handleQueue)
	mux.HandleFunc("POST /cancel", hub.handleCancel)
	mux.HandleFunc("POST /cpu", hub.handleCPU)
	mux.HandleFunc("POST /move", hub.handleMove)
	mux.HandleFunc("POST /character", hub.handleCharacter)

	var listener net.Listener
	if *addr != "" {
		listener, err = net.Listen("tcp", *addr)
		if err != nil {
			log.Printf("port %s unavailable, scanning 8000–8999", *addr)
		}
	}
	if listener == nil {
		for port := 8000; port <= 8999; port++ {
			listener, err = net.Listen("tcp", fmt.Sprintf(":%d", port))
			if err == nil {
				break
			}
		}
	}
	if listener == nil {
		log.Fatal("no available port in 8000–8999")
	}

	log.Printf("KACHIPUN TOURNAMENT listening on %s", listener.Addr())
	log.Fatal(http.Serve(listener, mux))
}
