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
	operationalFlags(flag.CommandLine)
	flag.Parse()

	sub, err := fs.Sub(webFS, "web")
	if err != nil {
		log.Fatal(err)
	}

	hub := NewHub()

	mux := hub.routes()
	mux.Handle("/", http.FileServer(http.FS(sub)))

	// KeepAlive arms TCP keepalive probes on every accepted connection so a
	// device that vanishes without a FIN is detected by the OS between SSE
	// frames (the /events loop's rolling write deadline covers blocked writes,
	// but only the kernel can notice a silent idle peer). This is the other
	// half of the bounded SSE connection lifetime.
	var listener net.Listener
	if *addr != "" {
		listener, err = (&net.ListenConfig{KeepAlive: 15 * time.Second}).Listen(context.Background(), "tcp", *addr)
		if err != nil {
			log.Printf("port %s unavailable, scanning 8000–8999", *addr)
		}
	}
	if listener == nil {
		for port := 8000; port <= 8999; port++ {
			listener, err = (&net.ListenConfig{KeepAlive: 15 * time.Second}).Listen(context.Background(), "tcp", fmt.Sprintf(":%d", port))
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
		Handler:      accessLog(hub.metrics, mux),
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

// operationalFlags exposes the operating values the engine and hub read as
// flags, so an install can be recorded and reproduced instead of being
// "whatever this build compiled in". Each flag is bound to the package var the
// code already reads and defaults to that var's shipped value, so the default
// and the runtime value cannot drift into two sources of truth. main calls this
// before flag.Parse(), before any goroutine or hub exists.
func operationalFlags(fs *flag.FlagSet) {
	fs.DurationVar(&shootWindow, "shoot-window", shootWindow, "how long after PUN a pick may arrive")
	fs.DurationVar(&readyTimeout, "ready-timeout", readyTimeout, "how long a match waits for both sides to be ready")
	fs.DurationVar(&sseWriteDeadline, "sse-write-deadline", sseWriteDeadline, "rolling per-write deadline on /events streams")
	fs.IntVar(&maxBodyBytes, "max-body-bytes", maxBodyBytes, "largest accepted POST body in bytes")
	fs.Float64Var(&rlCapacity, "rl-capacity", rlCapacity, "rate-limit burst tokens per IP")
	fs.Float64Var(&rlRefillPerSec, "rl-refill-per-sec", rlRefillPerSec, "rate-limit sustained refill tokens per second")
	fs.IntVar(&rlMaxEntries, "rl-max-entries", rlMaxEntries, "rate limiter map cap")
}
