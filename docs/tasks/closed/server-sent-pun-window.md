# Server-sent PUN window

Each `shoot` event carries `windowMs`; the client uses the authoritative,
server-determined window for its input lock and surfaces `400`/`409` rejections
inline instead of silently reporting a "Timed out" result.
