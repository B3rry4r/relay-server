# Relay Persistence & Configuration

This document outlines where Relay stores its persistent configuration, internal state, and tool definitions on the filesystem.

## opencode Persistence

The `opencode` agent persists its data and configuration in the following locations within the `/workspace` volume. 

**Warning**: Deleting these folders can result in loss of configuration, session history, or agent functionality.

| Directory | Purpose | Consequence of Deletion |
| :--- | :--- | :--- |
| `/workspace/.config/opencode` | User configuration (settings, preferences). | Resets application settings to default. |
| `/workspace/.local/share/opencode` | Persistent user data (session history, custom agents). | Loss of session history and persisted user data. |
| `/workspace/.local/state/opencode` | Runtime state (logs, current task status). | May cause errors or reset the agent's current task status. |
| `/workspace/.cache/opencode` | Temporary caches. | Slows down performance while caches are rebuilt. Safe to delete. |
| `/workspace/.relay/tools/.../opencode-ai` | Installed agent binaries. | Breaks `opencode` functionality until re-installed. |

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
