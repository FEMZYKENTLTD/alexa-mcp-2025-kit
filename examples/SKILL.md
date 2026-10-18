---
name: status-card
description: Display an interactive status card with Alexa MCP Apps.
version: 1.0.0
mcpSpecVersion: '2025-11-25'
triggers:
  - show my status
  - display status card
tools:
  - show_status
uiResources:
  - ui://status/card
---
# Status card

Call `show_status` with a short `label`. The host can render `ui://status/card`
using the MCP Apps resource advertised in `tools/list`.
