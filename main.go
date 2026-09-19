package main

import (
	"context"
	"embed"
	"errors"
	"flag"
	"fmt"
	"io/fs"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"
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
	mux.HandleFunc("POST /ready", hub.handleReady)
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

	ctx, stopSignals := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stopSignals()

	srv := &http.Server{
		Handler:      mux,
		ReadTimeout:  10 * time.Second,
		WriteTimeout: 20 * time.Second,
	}
	go func() {
		<-ctx.Done()
		log.Println("shutting down")
		hub.Shutdown()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := srv.Shutdown(shutdownCtx); err != nil {
			log.Printf("graceful shutdown: %v", err)
			srv.Close()
		}
	}()

	if err := srv.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
	log.Println("server stopped")
}
