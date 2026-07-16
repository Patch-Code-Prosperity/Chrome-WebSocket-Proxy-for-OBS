let obsSocket = null;

let connectionStatus = {
    chromeWebSocket: 'disconnected',
    obsWebSocket: 'disconnected'
};

let messageStats = {
    received: 0,
    forwarded: 0,
    sent: 0,
    lost: 0
};

let obsStats = {
    scenes: 0,
    sources: 0,
    streaming: false,
    recording: false
};

let latestStatus = {
    connectionStatus: connectionStatus,
    messageStats: messageStats,
    obsStats: obsStats
};

let debuggeeId = null;

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    switch(request.action) {
        case "getStatus":
            sendResponse({
                connectionStatus: connectionStatus,
                messageStats: messageStats,
                obsStats: obsStats
            });
            break;
        case "connectObs":
            connectToObs();
            sendResponse({success: true});
            break;
        case "disconnectObs":
            disconnectFromObs();
            sendResponse({success: true});
            break;
        case "toggleChromeWs":
            if (debuggeeId) {
                chrome.debugger.detach(debuggeeId);
                debuggeeId = null;
                updateStatus('chromeWebSocket', 'disconnected');
            } else {
                attachDebugger(request.tabId);
            }
            sendResponse({success: true});
            break;
    }
    return true;  // Indicates that the response is sent asynchronously
});

chrome.action.onClicked.addListener((tab) => {
    if (debuggeeId) {
        chrome.debugger.detach(debuggeeId);
        debuggeeId = null;
        updateStatus('chromeWebSocket', 'disconnected');
    } else {
        attachDebugger(tab.id);
    }
});

// requestId -> socket URL, so every forwarded frame can be labeled with
// which of the stream's several WebSocket sessions it came from (Whatnot
// runs ~3 per stream: livestream, commerce, viewer/presence).
let socketUrls = {};

function attachDebugger(tabId) {
    chrome.debugger.attach({tabId: tabId}, "1.3", () => {
        if (chrome.runtime.lastError) {
            console.error(chrome.runtime.lastError.message);
            return;
        }
        debuggeeId = {tabId: tabId};
        socketUrls = {};
        chrome.debugger.sendCommand(debuggeeId, "Network.enable");
        chrome.debugger.onEvent.addListener(onEvent);
        updateStatus('chromeWebSocket', 'connected');
    });
}

function onEvent(debuggeeId, message, params) {
    if (message === "Network.webSocketCreated") {
        socketUrls[params.requestId] = params.url;
    } else if (message === "Network.webSocketFrameReceived") {
        const payload = params.response?.payloadData || params.request?.payloadData;
        if (payload) {
            messageStats.received++;
            const socketUrl = socketUrls[params.requestId] || "";
            // Forward EVERY valid-JSON frame from EVERY socket. The Phoenix
            // array shape [join_ref, ref, topic, event, payload] is unpacked
            // for convenience, but non-array frames are forwarded too (tagged
            // raw) so no session is silently dropped — presence/join/leave may
            // ride a socket that doesn't use the array shape.
            try {
                const parsed = JSON.parse(payload);
                forwardToObs(parsed, socketUrl);
            } catch (error) {
                messageStats.lost++;   // genuinely non-JSON (e.g. binary)
            }
        }
    } else if (message === "Network.webSocketFrameSent") {
        if (params.request?.payloadData) messageStats.sent++;
    }
    updateStatus('chromeWebSocket', 'connected');
}

function connectToObs() {
    chrome.storage.sync.get(['forwardUrl', 'wsPassword'], function(result) {
        const forwardUrl = result.forwardUrl || 'ws://localhost:4455';
        const wsPassword = result.wsPassword || '';

        console.log('Attempting to connect to OBS WebSocket at:', forwardUrl);

        if (obsSocket && obsSocket.readyState === WebSocket.OPEN) {
            console.log('Already connected to OBS WebSocket');
            return;
        }

        obsSocket = new WebSocket(forwardUrl);

        // obs-websocket v5 handshake: wait for Hello (op 0), answer with
        // Identify (op 1) — including the auth response if OBS challenges.
        obsSocket.onopen = () => {
            console.log('OBS WebSocket connection opened, waiting for Hello');
        };

        obsSocket.onerror = (error) => {
            console.error('OBS WebSocket Error:', error);
            updateStatus('obsWebSocket', 'error');
        };

        obsSocket.onclose = (event) => {
            // 4008/4009 = authentication missing/failed per the v5 spec
            const authCodes = { 4008: 'auth required', 4009: 'auth failed' };
            const reason = authCodes[event.code] || event.reason || '';
            console.log('Disconnected from OBS WebSocket. Code:', event.code, 'Reason:', reason);
            updateStatus('obsWebSocket', authCodes[event.code] ? 'auth_failed' : 'disconnected');
        };

        obsSocket.onmessage = (event) => {
            const message = JSON.parse(event.data);
            handleOBSMessage(message, wsPassword);
        };
    });
}

async function sha256B64(str) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
    return btoa(String.fromCharCode(...new Uint8Array(buf)));
}

async function handleOBSMessage(message, password) {
    switch (message.op) {
        case 0: { // Hello -> Identify (with auth answer if challenged)
            const identify = { op: 1, d: { rpcVersion: 1, eventSubscriptions: 0 } };
            const auth = message.d.authentication;
            if (auth) {
                if (!password) {
                    console.error('OBS requires a password — set it in the extension options.');
                    updateStatus('obsWebSocket', 'auth_failed');
                    obsSocket.close();
                    return;
                }
                const secret = await sha256B64(password + auth.salt);
                identify.d.authentication = await sha256B64(secret + auth.challenge);
            }
            obsSocket.send(JSON.stringify(identify));
            break;
        }
        case 2: // Identified
            console.log('Identified successfully with OBS');
            updateStatus('obsWebSocket', 'authenticated');
            getOBSStats();
            break;
        case 7: // Request response
            handleOBSResponse(message);
            break;
        default:
            console.log('Unhandled message type:', message.op);
    }
}

function handleOBSResponse(message) {
    console.log('Received response from OBS:', message);
    if (message.d && message.d.requestType) {
        // count rejected requests as lost instead of pretending they forwarded
        if (message.d.requestStatus && !message.d.requestStatus.result) {
            console.error('OBS rejected', message.d.requestType, message.d.requestStatus);
            if (message.d.requestType === 'BroadcastCustomEvent') {
                messageStats.lost++;
                if (messageStats.forwarded > 0) messageStats.forwarded--;
            }
            return;
        }
        switch (message.d.requestType) {
            case 'GetSceneList':
                if (message.d.responseData && message.d.responseData.scenes) {
                    obsStats.scenes = message.d.responseData.scenes.length;
                    console.log('Updated scenes count:', obsStats.scenes);
                }
                break;
            case 'GetInputList':
                if (message.d.responseData && message.d.responseData.inputs) {
                    obsStats.sources = message.d.responseData.inputs.length;
                    console.log('Updated sources count:', obsStats.sources);
                }
                break;
            case 'GetStreamStatus':
                if (message.d.responseData && message.d.responseData.outputActive !== undefined) {
                    obsStats.streaming = message.d.responseData.outputActive;
                    console.log('Updated streaming status:', obsStats.streaming);
                }
                break;
            case 'GetRecordStatus':
                if (message.d.responseData && message.d.responseData.outputActive !== undefined) {
                    obsStats.recording = message.d.responseData.outputActive;
                    console.log('Updated recording status:', obsStats.recording);
                }
                break;
            case 'BroadcastCustomEvent':
                console.log('Custom event broadcasted successfully');
                break;
            default:
                console.log('Unhandled response type:', message.d.requestType);
        }
        updateStatus('obsWebSocket', 'connected');
    } else {
        console.log('Unexpected response format:', message);
    }
}

function updateStatus(type, status) {
     // Only update if the status has changed
    if (connectionStatus[type] !== status) {
        connectionStatus[type] = status;
        console.log(`Updating status: ${type} = ${status}`);
        
        latestStatus = {
            connectionStatus: connectionStatus,
            messageStats: messageStats,
            obsStats: obsStats
        };

        // Use chrome.runtime.sendMessage instead of chrome.tabs.sendMessage
        chrome.runtime.sendMessage({ 
            action: 'statusUpdate',
            ...latestStatus
        }).catch(error => {
            console.log('Error sending status update:', error.message);
        });
        
        // Update extension icon
        const iconPath = status === 'connected' ? {
            16: 'images/icon_active_16.png',
            32: 'images/icon_active_32.png',
            48: 'images/icon_active_48.png',
            128: 'images/icon_active_128.png'
        } : {
            16: 'images/icon_inactive_16.png',
            32: 'images/icon_inactive_32.png',
            48: 'images/icon_inactive_48.png',
            128: 'images/icon_inactive_128.png'
        };
        chrome.action.setIcon({path: iconPath});
    }
}

function forwardToObs(parsed, socketUrl) {
    if (!obsSocket || obsSocket.readyState !== WebSocket.OPEN) {
        messageStats.lost++;
        updateStatus('obsWebSocket', 'disconnected');
        return;
    }
    // Phoenix frames are arrays [join_ref, ref, topic, event, payload].
    // Anything else (a plain object, etc.) is forwarded tagged as raw so the
    // downstream capture sees it instead of it being dropped.
    let eventData;
    if (Array.isArray(parsed)) {
        eventData = {channel: parsed[2], event: parsed[3], payload: parsed[4], socket: socketUrl};
    } else {
        eventData = {channel: "(nonphoenix)", event: "raw_frame", payload: parsed, socket: socketUrl};
    }
    try {
        obsSocket.send(JSON.stringify({
            op: 6,
            d: {
                requestType: "BroadcastCustomEvent",  // v4 BroadcastCustomMessage is rejected by OBS 28+
                requestId: generateUniqueId(),
                requestData: {eventData: {eventType: "ChromeWebSocketMessage", eventData}}
            }
        }));
        messageStats.forwarded++;
    } catch (error) {
        console.error("Error forwarding message to OBS:", error);
        messageStats.lost++;
    }
    updateStatus('obsWebSocket', 'connected');
}

function generateUniqueId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2);
}

function getOBSStats() {
    if (obsSocket && obsSocket.readyState === WebSocket.OPEN) {
        // Get scene list
        sendOBSRequest('GetSceneList', {}, (response) => {
            handleOBSResponse(response);
        });

        // Get sources list
        sendOBSRequest('GetInputList', {}, (response) => {
            handleOBSResponse(response);
        });

        // Get streaming status
        sendOBSRequest('GetStreamStatus', {}, (response) => {
            handleOBSResponse(response);
        });

        // Get recording status
        sendOBSRequest('GetRecordStatus', {}, (response) => {
            handleOBSResponse(response);
        });
    }
}

function sendOBSRequest(requestType, requestData, callback) {
    if (!obsSocket || obsSocket.readyState !== WebSocket.OPEN) {
        console.error('OBS WebSocket is not connected');
        return;
    }

    const requestId = Math.random().toString(36).substr(2, 9);
    const request = {
        op: 6,
        d: {
            requestType: requestType,
            requestId: requestId,
            ...requestData
        }
    };

    console.log('Sending OBS request:', request);
    obsSocket.send(JSON.stringify(request));

    const messageHandler = (event) => {
        const message = JSON.parse(event.data);
        if (message.op === 7 && message.d.requestId === requestId) {
            obsSocket.removeEventListener('message', messageHandler);
            callback(message);
        }
    };

    obsSocket.addEventListener('message', messageHandler);
}

// Remove or comment out the periodic OBS stats update
// setInterval(getOBSStats, 5000);  // Update every 5 seconds

function disconnectFromObs() {
    if (obsSocket && obsSocket.readyState === WebSocket.OPEN) {
        obsSocket.close();
        console.log('Disconnected from OBS WebSocket');
        updateStatus('obsWebSocket', 'disconnected');
        // Reset OBS stats
        obsStats = {
            scenes: 0,
            sources: 0,
            streaming: false,
            recording: false
        };
    } else {
        console.log('OBS WebSocket is not connected');
    }
}