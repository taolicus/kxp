package main

import (
	"strconv"
	"sync"
	"time"
)

// HubMetrics is a small counter set for the /metrics endpoint. Counters
// increment at the same points the logging slice already hooks, so operators
// can poll numbers without parsing log lines. All fields are guarded by a
// single mutex — contention is trivial at this request volume.
type HubMetrics struct {
	mu            sync.Mutex
	started       time.Time
	requests      int
	rejects       int
	joined        int
	left          int
	dropped       int
	rateLimited   int
	streamsOpened int

	byStatus map[string]int
	byCode   map[string]int
	byMsg    map[string]int

	beacons      int
	byBeaconKind map[string]int
}

func newHubMetrics() *HubMetrics {
	return &HubMetrics{
		started:      time.Now(),
		byStatus:     make(map[string]int),
		byCode:       make(map[string]int),
		byMsg:        make(map[string]int),
		byBeaconKind: make(map[string]int),
	}
}

func (m *HubMetrics) incRequest(status int) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.requests++
	m.byStatus[strconv.Itoa(status)]++
}

func (m *HubMetrics) incReject(code int, msg string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.rejects++
	m.byCode[strconv.Itoa(code)]++
	if len(msg) > 32 {
		msg = msg[:32]
	}
	m.byMsg[msg]++
}

func (m *HubMetrics) incJoined() {
	m.mu.Lock()
	m.joined++
	m.mu.Unlock()
}

func (m *HubMetrics) incLeft() {
	m.mu.Lock()
	m.left++
	m.mu.Unlock()
}

func (m *HubMetrics) incDropped() {
	m.mu.Lock()
	m.dropped++
	m.mu.Unlock()
}

func (m *HubMetrics) incRateLimited() {
	m.mu.Lock()
	m.rateLimited++
	m.mu.Unlock()
}

func (m *HubMetrics) incStreamOpened() {
	m.mu.Lock()
	m.streamsOpened++
	m.mu.Unlock()
}

func (m *HubMetrics) incBeacon(kind string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.beacons++
	m.byBeaconKind[kind]++
}

// Copy returns a point-in-time snapshot of the counters plus a copy of the
// distribution maps under one lock hold.
func (m *HubMetrics) Copy() HubMetricsView {
	m.mu.Lock()
	defer m.mu.Unlock()
	return HubMetricsView{
		Requests:      m.requests,
		Rejects:       m.rejects,
		Joined:        m.joined,
		Left:          m.left,
		DroppedEvents: m.dropped,
		RateLimited:   m.rateLimited,
		StreamsOpened: m.streamsOpened,
		Beacons:       m.beacons,
		ByStatus:      cloneMap(m.byStatus),
		ByCode:        cloneMap(m.byCode),
		ByMsg:         cloneMap(m.byMsg),
		ByBeaconKind:  cloneMap(m.byBeaconKind),
	}
}

// HubMetricsView is a serializable snapshot for the /metrics handler.
type HubMetricsView struct {
	Requests      int            `json:"requests"`
	Rejects       int            `json:"rejects"`
	Joined        int            `json:"joined"`
	Left          int            `json:"left"`
	DroppedEvents int            `json:"droppedEvents"`
	RateLimited   int            `json:"rateLimited"`
	StreamsOpened int            `json:"streamsOpened"`
	Beacons       int            `json:"beacons"`
	ByStatus      map[string]int `json:"byStatus"`
	ByCode        map[string]int `json:"byCode"`
	ByMsg         map[string]int `json:"byMsg"`
	ByBeaconKind  map[string]int `json:"byBeaconKind"`
}

func cloneMap(in map[string]int) map[string]int {
	out := make(map[string]int, len(in))
	for k, v := range in {
		out[k] = v
	}
	return out
}

func (m *HubMetrics) uptime() time.Duration { return time.Since(m.started) }
