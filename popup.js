document.addEventListener('DOMContentLoaded', function() {
    requestLatestStatus();

    document.getElementById('refreshStatus').addEventListener('click', requestLatestStatus);
    document.getElementById('connectObs').addEventListener('click', connectToObs);
    document.getElementById('disconnectObs').addEventListener('click', disconnectFromObs);
});

function requestLatestStatus() {
    chrome.runtime.sendMessage({action: "getStatus"}, (response) => {
        if (chrome.runtime.lastError) {
            console.error('Error getting status:', chrome.runtime.lastError);
        } else {
            updatePopupUI(response);
        }
    });
}

function updatePopupUI(status) {
    console.log('Updating popup UI with status:', status);
    document.getElementById('chromeWsStatus').textContent = status.connectionStatus.chromeWebSocket;
    document.getElementById('wsReceived').textContent = status.messageStats.received;
    document.getElementById('wsForwarded').textContent = status.messageStats.forwarded;
    document.getElementById('wsLost').textContent = status.messageStats.lost;
    document.getElementById('wsSent').textContent = status.messageStats.sent;

    document.getElementById('obsWsStatus').textContent = status.connectionStatus.obsWebSocket;
    document.getElementById('obsScenes').textContent = status.obsStats.scenes;
    document.getElementById('obsSources').textContent = status.obsStats.sources;
    document.getElementById('obsStreaming').textContent = status.obsStats.streaming ? 'Yes' : 'No';
    document.getElementById('obsRecording').textContent = status.obsStats.recording ? 'Yes' : 'No';
}

function connectToObs() {
    chrome.runtime.sendMessage({action: "connectObs"}, (response) => {
        if (chrome.runtime.lastError) {
            console.error('Error connecting to OBS:', chrome.runtime.lastError);
        } else {
            console.log('OBS connection initiated');
            requestLatestStatus();
        }
    });
}

function disconnectFromObs() {
    chrome.runtime.sendMessage({action: "disconnectObs"}, (response) => {
        if (chrome.runtime.lastError) {
            console.error('Error disconnecting from OBS:', chrome.runtime.lastError);
        } else {
            console.log('OBS disconnection initiated');
            requestLatestStatus();
        }
    });
}

// Listen for updates
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'statusUpdate') {
        updatePopupUI(message);
    }
});
