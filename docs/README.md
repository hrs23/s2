# S2 docs

Architecture and contracts that code alone does not make obvious. Schema lives in `migrations/20260101000000_init.sql`, HTTP contracts in `openapi.yaml`, deployment in the [README](../README.md#self-host).

| Doc | Answers |
|---|---|
| [D01-architecture](D01-architecture.md) | Layers and runtime |
| [D02-storage](D02-storage.md) | How files, revisions, and chunks are stored |
| [D03-permissions](D03-permissions.md) | Grants, scopes, tokens, and who may access what |
| [D04-auth](D04-auth.md) | Sign-in methods and the OAuth server |
| [D05-gateway](D05-gateway.md) | REST, WebDAV, and MCP surfaces |
| [D06-limits](D06-limits.md) | Per-user quotas and limits |
| [D07-reference](D07-reference.md) | Table ownership and deletion cascades |

## Writing rules

- English only; describe current behavior, not history or roadmaps.
- Keep only what the code does not make obvious; link instead of duplicating.
- Do not restate column types, indexes, or OpenAPI shapes.
- Prefer tables and bullets; no narrative or trade-off sections.
