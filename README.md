# OBS Chrome WebSocket Extension

This Chrome extension monitors WebSocket traffic and forwards it to OBS (Open Broadcaster Software), bridging web applications and OBS for real-time interaction and updates.

## Features

- Monitor WebSocket traffic in Chrome
- Forward WebSocket messages to OBS
- Connect to OBS WebSocket server
- User-friendly popup interface
- Configurable settings

## Installation

1. Clone this repository or download the source code.
2. Open Chrome and navigate to `chrome://extensions/`.
3. Enable "Developer mode" in the top right corner.
4. Click "Load unpacked" and select the directory containing the extension files.

## Usage

1. Click the extension icon in Chrome to open the popup interface.
2. Use "Connect Chrome WS" to start monitoring WebSocket traffic.
3. Use "Connect to OBS" to establish a connection with your OBS WebSocket server.
4. The popup displays connection status and message statistics.

## Configuration

1. Right-click the extension icon and select "Options".
2. Set the OBS WebSocket server URL and password.
3. Click "Save Settings" to apply changes.

## Files Overview

- `manifest.json`: Extension configuration
- `background.js`: Main extension logic
- `popup.html` and `popup.js`: User interface and functionality
- `options.html` and `options.js`: Settings page and functionality

## Development

To modify or extend the extension:

1. Edit relevant files (e.g., `background.js` for core logic, `popup.js` for UI interactions).
2. Reload the extension in Chrome to apply changes.
3. Use Chrome's developer tools for debugging.

## License

This project is licensed under the GNU Lesser General Public License v2.1.

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## Support

If you encounter issues or have questions, please file an issue on the GitHub repository.

## Acknowledgements

- [OBS Studio](https://obsproject.com/) for providing a robust platform for live streaming.
- [OBS WebSocket](https://github.com/obsproject/obs-websocket) for enabling WebSocket control of OBS.

## Disclaimer

This project is not officially affiliated with OBS Studio or its WebSocket plugin. Use it at your own risk.
