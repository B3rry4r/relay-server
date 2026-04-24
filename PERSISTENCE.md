# Relay Persistence & Configuration

This document outlines where Relay stores its persistent configuration, internal state, and tool definitions on the filesystem.

## Storage Locations

All core Relay persistence is located within the workspace volume:

-   **`/workspace/.relay/`**: The primary directory for Relay's persistent state.
    -   **Tool Configurations**: Stores persistent custom tool definitions.
    -   **Workspace State**: Stores internal workspace session data and configuration.
-   **`/workspace/.local/` & `/workspace/.cache/`**: Used by system processes and package managers (like `npm`) for runtime data, package caches, and build artifacts.
-   **`/workspace/projects/`**: The root directory for user projects.

## Access

These files are primarily accessed by the `relay-server` backend to manage:
1.  **Project State**: Detecting git repositories, tracking port activity, and health monitoring.
2.  **Tool Management**: Registering, installing, and uninstalling custom tools or managed SDKs.
3.  **Environment Config**: Maintaining persistent settings across sessions.
