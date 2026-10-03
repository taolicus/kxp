# Both ends of the pick window are authoritative

`resolve` judged only the near end, `arrive >= shootAt`, and left the far end to
`handleMove`.

→ rationale: [architecture.md#timing-model](../../features/architecture.md#timing-model)
