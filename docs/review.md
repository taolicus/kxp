1. Authoritative server timing — The server should decide when PUN starts and whether a move was early, valid, or too late.


2. Clear game state machine — Game states such as waiting, countdown, PUN, resolving, and result should be explicit and enforce valid transitions.


3. Server-side rule enforcement — The server must enforce all game rules rather than trusting the browser.


4. Reaction-time definition — Clearly define what timestamp is used to calculate a player's reaction time.


5. Clock synchronization — If client-side timing is used, account for differences between client and server clocks.


6. Concurrent match safety — Concurrent requests from players must not corrupt or produce inconsistent match state.


7. Race-detector testing — The project should be tested with Go's race detector to find concurrency bugs.


8. Matchmaking synchronization — Simultaneous players joining matchmaking must be paired correctly without race conditions.


9. Abandoned-player handling — Players who disconnect or disappear should not leave matches permanently stuck.


10. SSE connection lifecycle — SSE connections should be correctly created, monitored, and cleaned up.


11. SSE disconnect detection — The server should detect when a browser closes or loses its SSE connection.


12. SSE error handling — Failed or interrupted SSE connections should be handled without crashing or corrupting game state.


13. SSE reconnection — Browsers should be able to reconnect sensibly after a temporary connection failure.


14. HTTP request validation — All player actions should validate methods, parameters, bodies, and move values.


15. Duplicate-action handling — Duplicate or repeated moves should not produce multiple results or corrupt state.


16. Late-action handling — Moves arriving after the legal window or after the game has ended should be rejected safely.


17. Invalid-action handling — Malformed or impossible actions should receive appropriate errors without affecting the match.


18. Request timeouts — HTTP operations should have sensible timeouts so connections cannot remain indefinitely active.


19. Resource limits — The server should limit connections, matches, requests, or other resources to prevent exhaustion.


20. Rate limiting — Public endpoints should have basic protection against clients sending excessive requests.


21. Session/player identity — Players should have reliable identifiers so the server can associate requests with the correct player.


22. Match ownership/isolation — A player should only be able to affect their own match and player state.


23. Graceful server shutdown — Shutdown should cleanly terminate active connections and avoid leaving state in a broken condition.


24. Pure game engine — Core game rules should be separated from HTTP, SSE, and other networking code where practical.


25. Deterministic testing — Game logic should be testable without relying on real wall-clock timing or actual network connections.


26. Timing edge-case tests — Tests should cover moves immediately before PUN, exactly at PUN, immediately after PUN, and at/after the timeout.


27. Game-state tests — Tests should cover every important state transition and invalid transition.


28. Disconnect tests — Tests should cover players disconnecting before PUN, after PUN, during a match, and after a result.


29. Simultaneous-move tests — Tests should verify both players submitting moves concurrently.


30. CPU determinism in tests — CPU reaction delays and moves should be controllable or deterministic during automated tests.


31. CPU timeout behavior — CPU behavior should correctly handle its reaction delay and the 1.2-second deadline.


32. Client/server timing UX — The UI should clearly communicate countdown, PUN, reaction timing, and timeout states.


33. Network latency transparency — The project should make clear whether displayed reaction times include network latency.


34. Browser trust model — Client-side timestamps, timers, and UI state should not be trusted for enforcing competitive rules.


35. Public-deployment security — The public server should have basic protections against malformed requests and abusive clients.


36. Anonymous resource abuse prevention — Anonymous users should not be able to create unlimited abandoned games or connections.


37. Reverse-proxy compatibility — SSE should work correctly through nginx or another reverse proxy without buffering or inappropriate timeouts.


38. SSE keepalive — Long-lived SSE connections should have a mechanism to prevent idle proxies from terminating them unnecessarily.


39. HTTP/server observability — Useful logs or metrics should exist for errors, connections, matchmaking, and game lifecycle events.


40. Production error handling — Internal errors should be handled safely without exposing unnecessary implementation details to clients.


41. Match cleanup — Completed, abandoned, and expired matches should eventually be removed from memory.


42. Stale-session cleanup — Player/session records that are no longer active should not accumulate indefinitely.


43. Leaderboard trust model — If a leaderboard is added, decide how reaction times and results can be trusted.


44. Leaderboard anti-cheat considerations — Competitive leaderboards should consider automated clients, forged timestamps, and other forms of manipulation.


45. Leaderboard identity — A persistent leaderboard needs a defined model for identifying players.


46. Game-mode architecture — The game logic should be structured so best-of-N and multiple-round modes can be added without rewriting the core system.


47. Player-name architecture — If names are added, define how names are assigned, validated, displayed, and associated with players.


48. Lobby/room architecture — If private rooms are added, define room creation, joining, discovery, and access control.


49. Tournament model — If the name "Tournament" is meant literally, define how individual matches combine into rounds and tournaments.


50. Documentation of architecture — The README should briefly explain the server, matchmaking, game state, SSE, and POST architecture.


51. Documentation of timing rules — The README should precisely explain how early moves, valid moves, reaction time, and timeout are determined.


52. Automated test workflow — The project should document and ideally automate commands such as go test ./... and go test -race ./....


53. Deployment robustness — The deployment process should handle failed builds, failed uploads, failed restarts, and service failures safely.


54. Configuration management — Address, ports, timing values, and other operational settings should be configurable where appropriate.


55. Graceful handling of multiple browser tabs — Multiple tabs or sessions from the same user should behave predictably rather than creating ambiguous player state.


