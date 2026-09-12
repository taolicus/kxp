package main

import (
	"embed"
	"flag"
	"io/fs"
	"log"
	"net/http"
)

//go:embed web
var webFS embed.FS

func main() {
	addr := flag.String("addr", ":8080", "listen address")
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

	log.Printf("kxp listening on %s", *addr)
	log.Fatal(http.ListenAndServe(*addr, mux))
}
