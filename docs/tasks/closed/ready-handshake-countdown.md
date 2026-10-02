# Ready-handshake countdown

A two-player match does not start KA/CHI until **both** clients advertise
readiness (`POST /ready`, re-sent every 2s while matched); a stale `matched`
reaching a client on the result screen routes to a healthy "match found" state.
Non-acking pairs are cancelled and the survivor(s) re-queued. CPU matches skip
the handshake. *(Amended: the gate now covers CPU matches too — see "CPU ready
gate" below.)* A `shootAt` field in the `shoot` event plus the client's
clock-skew estimate let the player act for the true remaining server window
whenever any is left (only a fully closed window shows "Waiting for result…").
