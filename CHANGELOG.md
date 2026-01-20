# Changelog

All notable changes to the NPM Runner extension will be documented in this file.

## [1.0.7] - 2026-01-20

### Added
- Package Manager Selection
  - Support for npm, yarn, and pnpm
  - Auto-detection from lockfile (pnpm-lock.yaml, yarn.lock, package-lock.json)
  - Configurable via settings (npmRunner.packageManager)
  - Shows active package manager in script info bar

- Close Confirmation with Port Kill
  - Prompts when closing a running script
  - Option to also kill the port when closing
  - Prevents accidentally leaving ports blocked

- Copy Output Button
  - New toolbar button to copy terminal output to clipboard
  - Strips ANSI color codes for clean text

- Execution Time Display
  - Shows how long a script has been running
  - Updates with format: seconds, minutes, hours

### Improved
- Scripts grouped alphabetically by project in Browse menu
- Cleaner script picker without redundant icons

## [1.0.6] - 2026-01-09

### Added
- **Port Detection in Tabs**
  - Running scripts now show detected port number in tab name
  - Example: `front:dev :5173` instead of just `front:dev`
  - Detects various patterns: localhost:port, "listening on", "port:", etc.

- **Package.json Watcher**
  - Automatically detects changes to dependencies and devDependencies
  - Shows notification when packages are added, removed, or updated
  - Options: Install, Install with Node version picker, or Dismiss
  - Debounced to avoid multiple notifications on rapid edits

### Improved
- Better port conflict detection for Kill Port feature

## [1.0.5] - 2026-01-09

### Added
- **Node Version Picker Improvements**
  - Shows installed versions vs available (not installed)
  - Installed versions marked with checkmark
  - Available LTS versions shown for easy installation
  - If selecting uninstalled version, prompts to install via nvm

### Improved
- Better version categorization in picker UI

## [1.0.4] - 2026-01-09

### Added
- **Node Version Switching**
  - Switch Node.js version per script
  - Persists version selection per script
  - Shows current Node version in panel header
  - Click "Switch Node" to change version for any script
  - Supports nvm and custom Node paths

### Improved
- Panel now resets correctly on Cursor/VS Code reload
- Fixed cached state issues

## [1.0.3] - 2026-01-08

### Added
- **Kill Port Feature**
  - Detects port conflicts in error output
  - Shows "Kill Port" button when EADDRINUSE errors occur
  - One-click to free stuck ports

- **Ask AI for Help**
  - On script errors, shows "Ask AI" button
  - Copies error context to clipboard
  - Opens Cursor AI chat for assistance

### Improved
- Icon-only toolbar buttons with tooltips
- Better color scheme using VS Code CSS variables
- Larger, more readable fonts
- Scrollable empty state area

## [1.0.2] - 2026-01-08

### Improved
- **Panel Redesign**
  - Tabs for each running script with project:script name format
  - Real-time output streaming directly in panel
  - Status indicators: running (green pulse), stopped (gray), error (red)
  - Toolbar with Stop, Restart, Clear buttons

### Fixed
- Output now shows in NPM Runner panel instead of terminal
- Proper process management and cleanup

## [1.0.1] - 2026-01-08

### Added
- **Running Scripts Panel**
  - Bottom panel showing all running scripts
  - Tab-based interface for multiple scripts
  - Real-time terminal output

- **Script Management**
  - Stop individual scripts
  - Restart scripts
  - Clear output

## [1.0.0] - 2026-01-08

### Initial Release
- **Play Buttons in package.json**
  - CodeLens buttons next to each script
  - Click to run or debug scripts instantly

- **Browse All Scripts**
  - Quick pick menu to search and run scripts
  - Shows all scripts from all workspace package.json files
  - Grouped by project

- **Status Bar Integration**
  - Shows count of running scripts
  - Click to open NPM Runner panel

### Configuration
- `npmRunner.showNodeVersion` - Show Node.js version before running
- `npmRunner.defaultNodeVersion` - Default Node version (empty = system)
- `npmRunner.confirmOnClose` - Confirm before closing running script
- `npmRunner.autoScrollOutput` - Auto-scroll terminal output

